// GET /api/sessions/[id]/track — компактный polyline для Leaflet MapTrack.
// Возвращает массив точек {lat,lng,t,v,st,alt} + segments по скорости (5 цветов) + harsh points.
// v2.10.0: карта по умолчанию открывается в слое street (OSM Standard tiles).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { haversineM } from "@/lib/geo";
import { normalizeSessionSpeeds } from "@/lib/kpi";

// v2.13.0 (Ф6): пороги резкости — §7.1/§7.2 (10 км/ч/с = 2,78 м/с²); раньше 10 м/с² (≈1g)
const HARSH_THRESHOLD_MS2 = 10 / 3.6;

// Пороги скоростных бакетов для цветовых сегментов (§7 методологии)
const SPEED_BUCKETS = [
  { max: 20, color: "#9ca3af", label: "0–20" },
  { max: 40, color: "#f59e0b", label: "20–40" },
  { max: 60, color: "#10b981", label: "40–60" },
  { max: 80, color: "#3b82f6", label: "60–80" },
  { max: 100, color: "#8b5cf6", label: "80–100" },
  { max: 999, color: "#dc2626", label: "100+" },
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const session = await db.session.findUnique({
      where: { id },
      include: { gpsPoints: { orderBy: { timestamp: "asc" }, select: { lat: true, lon: true, timestamp: true, speed: true, altitude: true, accuracy: true, bearing: true } } },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const points = session.gpsPoints;
    if (points.length === 0) {
      return json({ sessionId: id, points: [], segments: [], harshPoints: [], bounds: null }, 200, { "X-Request-Id": requestId });
    }

    const startMs = Number(points[0].timestamp);
    const startLat = points[0].lat;
    const startLng = points[0].lon;

    // v2.13.0 (Ф6): normalizeSessionSpeeds (AUDIT B-4) — как в /stats и /events.
    // Сырое поле speed бывает битым (запись с пиком 166 км/ч имела speed ≤ 20 км/ч) —
    // весь трек окрашивался в «0–20». Теперь скорость согласована с геометрией.
    const rawNorm = session.gpsPoints.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      timestamp: Number(p.timestamp),
      speed: p.speed,
      bearing: p.bearing,
      accuracy: p.accuracy,
      altitude: p.altitude,
    }));
    const normPoints = normalizeSessionSpeeds(rawNorm);

    // Компактный массив точек: [t_sec, lat, lng, v_ms, alt, st(0/1), brg]
    // st = 1 если moving (v > 0.5 м/с), иначе 0
    const trackPoints = normPoints.map((p, i) => {
      const t = Math.round((Number(p.timestamp) - startMs) / 1000);
      const v = p.speed ?? 0; // м/с, нормализованная (AUDIT B-4)
      return {
        i,
        t,
        lat: p.lat,
        lng: p.lon,
        v: Math.round(v * 10) / 10,
        alt: p.altitude ?? null,
        brg: p.bearing ?? null,
        acc: p.accuracy ?? null,
        st: v > 0.5 ? 1 : 0,
      };
    });

    // v2.13.0 (Ф6): пороги бакетов — КМ/Ч (как в легенде и скоростном профиле §5.3);
    // раньше v (м/с) сравнивалась с числами 20/40/60/… — сдвиг в 3,6×.
    const colorForSpeedKmh = (kmh: number | null): string => {
      if (kmh === null) return "#9ca3af";
      for (const b of SPEED_BUCKETS) if (kmh <= b.max) return b.color;
      return "#dc2626";
    };

    // Цветовые сегменты по скорости — группа последовательных точек с одним цветом
    // v2.13.0 (Ф6): цвет — по КМ/Ч нормализованной скорости
    const segments: { color: string; bucket: string; points: { lat: number; lng: number }[]; startIndex: number; endIndex: number }[] = [];
    const kmhOf = (p: (typeof trackPoints)[number]) => p.v != null ? p.v * 3.6 : null;
    let currentColor = colorForSpeedKmh(kmhOf(trackPoints[0]));
    let currentBucket = SPEED_BUCKETS.find((b) => b.color === currentColor)?.label ?? "?";
    let currentPoints: { lat: number; lng: number }[] = [{ lat: trackPoints[0].lat, lng: trackPoints[0].lng }];
    let startIndex = 0;

    for (let i = 1; i < trackPoints.length; i++) {
      const c = colorForSpeedKmh(kmhOf(trackPoints[i]));
      if (c === currentColor) {
        currentPoints.push({ lat: trackPoints[i].lat, lng: trackPoints[i].lng });
      } else {
        segments.push({ color: currentColor, bucket: currentBucket, points: currentPoints, startIndex, endIndex: i - 1 });
        currentColor = c;
        currentBucket = SPEED_BUCKETS.find((b) => b.color === c)?.label ?? "?";
        currentPoints = [{ lat: trackPoints[i].lat, lng: trackPoints[i].lng }];
        startIndex = i;
      }
    }
    if (currentPoints.length > 0) {
      segments.push({ color: currentColor, bucket: currentBucket, points: currentPoints, startIndex, endIndex: trackPoints.length - 1 });
    }

    // Разрывы: если dt > 30 сек → пунктир
    const gaps: { fromIdx: number; toIdx: number; durationSec: number }[] = [];
    for (let i = 1; i < trackPoints.length; i++) {
      const dt = trackPoints[i].t - trackPoints[i - 1].t;
      if (dt > 30) {
        gaps.push({ fromIdx: i - 1, toIdx: i, durationSec: dt });
      }
    }

    // Точки резких торможений/разгонов — v2.13.0 (Ф3/Ф6): нормализованные м/с,
    // порог §7.1/§7.2 = 10 км/ч/с (2,78 м/с²); раньше 10 м/с² ≈ 1g — кольца
    // «резкое торможение» на карте почти не появлялись.
    const harshPoints: { lat: number; lng: number; type: "braking" | "acceleration"; dv: number; idx: number; t: number }[] = [];
    for (let i = 2; i < trackPoints.length - 2; i++) {
      const v0 = trackPoints[i - 2].v;
      const v1 = trackPoints[i + 2].v;
      const dt = (trackPoints[i + 2].t - trackPoints[i - 2].t);
      if (v0 == null || v1 == null || dt === 0) continue;
      const accel = (v1 - v0) / dt; // м/с²
      if (Math.abs(accel) > HARSH_THRESHOLD_MS2) {
        harshPoints.push({
          lat: trackPoints[i].lat,
          lng: trackPoints[i].lng,
          type: accel < 0 ? "braking" : "acceleration",
          dv: Math.round(accel * 10) / 10,
          idx: i,
          t: trackPoints[i].t,
        });
      }
    }

    // Bounds для авто-зума Leaflet
    let minLat = startLat, maxLat = startLat, minLng = startLng, maxLng = startLng;
    for (const p of trackPoints) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }

    return json(
      {
        sessionId: id,
        deviceId: session.deviceId,
        startTime: session.startTime,
        endTime: session.endTime,
        pointCount: session.pointCount,
        // Bounds для авто-зума [[south, west], [north, east]]
        bounds: [[minLat, minLng], [maxLat, maxLng]],
        // Полный массив точек (компактный формат)
        points: trackPoints,
        // Цветовые сегменты для Leaflet Polyline layers
        segments,
        // Разрывы (>30сек gaps) — рисуем пунктиром
        gaps,
        // Точки резких торможений/разгонов — отдельный маркерный слой
        harshPoints,
        // Точки START/FINISH
        markers: {
          start: { lat: trackPoints[0].lat, lng: trackPoints[0].lng, t: trackPoints[0].t },
          finish: { lat: trackPoints[trackPoints.length - 1].lat, lng: trackPoints[trackPoints.length - 1].lng, t: trackPoints[trackPoints.length - 1].t },
        },
        // Метаданные для layer switcher
        defaultLayer: "street",
        availableLayers: ["street", "satellite", "terrain", "dark"],
        // Легенда бакетов
        legend: SPEED_BUCKETS.map((b) => ({ color: b.color, label: b.label })),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (e) {
    logger.error("track fetch failed", { requestId, error: (e as Error).message });
    return json({ error: (e as Error).message }, 500, { "X-Request-Id": requestId });
  }
}
