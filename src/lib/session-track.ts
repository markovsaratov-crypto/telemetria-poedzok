// src/lib/session-track.ts — v2.19.0: ЕДИНЫЙ конвейер трека (код перенесён
// ДОСЛОВНО из src/app/api/sessions/[id]/track/route.ts).
// Потребители: одиночный роут (тонкая обёртка) и батч-роут /api/track/batch —
// тот же паттерн единого конвейера, что session-stats.ts / session-events.ts.
//
// Входные точки — уже загруженные из БД (ORDER BY timestamp asc на стороне SQL).

import { normalizeSessionSpeeds, HARSH_THRESHOLD_MS2 } from "./kpi"; // v2.16.0: единый порог §7.1/§7.2

// Пороги скоростных бакетов для цветовых сегментов (§7 методологии) —
// presentation-схема карты (цвет+подпись), отличная от KPI-бакетов kpi.ts
const SPEED_BUCKETS = [
  { max: 20, color: "#9ca3af", label: "0–20" },
  { max: 40, color: "#f59e0b", label: "20–40" },
  { max: 60, color: "#10b981", label: "40–60" },
  { max: 80, color: "#3b82f6", label: "60–80" },
  { max: 100, color: "#8b5cf6", label: "80–100" },
  { max: 999, color: "#dc2626", label: "100+" },
];

export interface TrackInputPoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null;
  timestamp: number;
}

export interface TrackSessionMeta {
  id: string;
  deviceId: string;
  startTime: string;
  endTime: string | null;
  pointCount: number | null;
}

type TrackPayload = Record<string, unknown>;

export function computeSessionTrack(session: TrackSessionMeta, rawPoints: TrackInputPoint[]): TrackPayload {
  if (rawPoints.length === 0) {
    // форма раннего return одиночного роута — ДОСЛОВНО
    return { sessionId: session.id, points: [], segments: [], harshPoints: [], bounds: null };
  }

  const startMs = Number(rawPoints[0].timestamp);
  const startLat = rawPoints[0].lat;
  const startLng = rawPoints[0].lon;

  // v2.13.0 (Ф6): normalizeSessionSpeeds (AUDIT B-4) — как в /stats и /events.
  // Сырое поле speed бывает битым (запись с пиком 166 км/ч имела speed ≤ 20 км/ч) —
  // весь трек окрашивался в «0–20». Теперь скорость согласована с геометрией.
  const normPoints = normalizeSessionSpeeds(rawPoints);

  // Компактный массив точек: {i, t, lat, lng, v, alt, brg, acc, st}
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

  return {
    sessionId: session.id,
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
  };
}
