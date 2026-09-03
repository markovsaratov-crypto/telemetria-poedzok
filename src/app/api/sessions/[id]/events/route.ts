// GET /api/sessions/[id]/events — детекция harsh events для G-G диаграммы.
// Возвращает longitudinal/lateral acceleration для каждой точки + harsh events список.
// v2.10.0: real AccelerationRMS/JerkRMS вместо seeded-манёвров.
// v2.12.0 (D-6): скорости нормализуются (AUDIT B-4) и сглаживаются 3-точечной
// медией — GPS-джиттер больше не порождает фантомные «резкие» события.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { normalizeSessionSpeeds, medianSmooth3, isUsableSpeedPoint, HARSH_THRESHOLD_MS2 } from "@/lib/kpi";
import { haversineM } from "@/lib/geo"; // v2.16.0 (D-9): канонический гаверсинус (была локальная копия)

// v2.13.0 (Ф3): порог приведён к методологии §7.1/§7.2 — 10 км/ч за секунду
// = 2,78 м/с². Раньше было 10 м/с² (≈1g — экстренное торможение): счётчик блока
// «События вождения» расходился с конвейером методологии (EcoScore) в ~5 раз.
// v2.16.0: константа — ЕДИНЫЙ HARSH_THRESHOLD_MS2 из kpi.ts (как в track-роуте).
const JERK_THRESHOLD_MS3 = 5; // |j| > 5 м/с³ → harsh jerk
const HIGH_SPEED_CORNER_THRESHOLD = 60; // скорость >60 км/ч (§7.10), угол — 45° ниже

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x = Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) - Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function normAngle(a: number): number {
  while (a < -180) a += 360;
  while (a > 180) a -= 360;
  return a;
}

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
      include: { gpsPoints: { orderBy: { timestamp: "asc" }, select: { lat: true, lon: true, timestamp: true, speed: true, bearing: true, accuracy: true } } },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    if (session.gpsPoints.length < 5) {
      return json(
        { sessionId: id, maneuvers: [], harshEvents: [], gg: { points: [], rings: [0.2, 0.4, 0.6] }, summary: { accelerationRMS: 0, jerkRMS: 0, harshBraking: 0, harshAcceleration: 0, maneuvers: 0 } },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // v2.12.0 (D-6): тот же конвейер подготовки скоростей, что и в /stats —
    // normalizeSessionSpeeds (AUDIT B-4) + 3-точечная медиана против GPS-выбросов.
    // Непригодные/отсутствующие скорости → 0 (как раньше «?? 0»), спайки гасятся медианой.
    const rawPoints = session.gpsPoints.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      timestamp: Number(p.timestamp),
      speed: p.speed,
      bearing: p.bearing,
      accuracy: p.accuracy,
      altitude: null,
    }));
    const points = normalizeSessionSpeeds(rawPoints);
    const speeds = medianSmooth3(
      points.map((p) => (isUsableSpeedPoint(p) ? (p.speed as number) : 0))
    ) as number[];

    // Вычисление longitudinal accel + lateral accel для каждой точки (кроме первых/последних 2)
    const maneuvers: { lat: number; lng: number; t: number; longA: number; latA: number; speed: number; bearing: number }[] = [];
    let prevA: number | null = null;
    const accelValues: number[] = [];
    const jerkValues: number[] = [];

    for (let i = 2; i < points.length - 2; i++) {
      const p0 = points[i - 2];
      const p1 = points[i - 1];
      const p2 = points[i];
      const p3 = points[i + 1];
      const p4 = points[i + 2];

      const dt1 = (Number(p2.timestamp) - Number(p0.timestamp)) / 1000;
      const dt2 = (Number(p4.timestamp) - Number(p2.timestamp)) / 1000;
      if (dt1 <= 0 || dt2 <= 0) continue;

      // v2.12.0 (D-6): сглаженные скорости — одиночные GPS-спайки не дают
      // фантомных ускорений (|a| > 10 м/с²) на стоянке
      const v1 = speeds[i - 1] ?? 0;
      const v2 = speeds[i] ?? 0;
      const v3 = speeds[i + 1] ?? 0;
      // Longitudinal accel: central difference
      const longA = (v3 - v1) / ((dt1 + dt2) / 2);
      accelValues.push(longA * longA);

      // Lateral accel: v² / R, где R = радиус кривизны
      // Используем изменение bearing для оценки radius
      const b1 = p1.bearing ?? bearingDeg(p0.lat, p0.lon, p1.lat, p1.lon);
      const b2 = p2.bearing ?? bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
      const b3 = p3.bearing ?? bearingDeg(p2.lat, p2.lon, p3.lat, p3.lon);
      // v2.13.0 (Ф2): БЕЗ Math.abs — знак поворота сохраняется (влево −, вправо +,
      // bearing растёт по часовой). Раньше latA ≥ 0 всегда → на G-G-диаграмме
      // левая половина была структурно пуста при любых данных.
      const db12 = normAngle(b2 - b1);
      const db23 = normAngle(b3 - b2);
      const totalTurn = db12 + db23;
      const distance12 = haversineM(p1.lat, p1.lon, p2.lat, p2.lon);
      const distance23 = haversineM(p2.lat, p2.lon, p3.lat, p3.lon);
      const totalDistance = distance12 + distance23;
      // lateral accel = v² * dθ/ds
      const vAvg = (v1 + v2 + v3) / 3;
      const latA = totalDistance > 0 ? (vAvg * vAvg * (totalTurn * Math.PI / 180)) / totalDistance : 0;

      // Jerk: производная accel
      if (prevA !== null) {
        const jerk = (longA - prevA) / ((dt1 + dt2) / 4);
        jerkValues.push(jerk * jerk);
      }
      prevA = longA;

      maneuvers.push({
        lat: p2.lat,
        lng: p2.lon,
        t: Math.round((Number(p2.timestamp) - Number(points[0].timestamp)) / 1000),
        longA: Math.round(longA * 100) / 100,
        latA: Math.round(latA * 100) / 100,
        speed: Math.round(v2 * 3.6 * 10) / 10, // в км/ч для удобства (сглаженная)
        bearing: Math.round(b2),
      });
    }

    // AccelerationRMS = sqrt(Σa²·dt/Σdt) (упрощённо: RMS от longA)
    const accelerationRMS = accelValues.length > 0 ? Math.sqrt(accelValues.reduce((s, v) => s + v, 0) / accelValues.length) : 0;
    const jerkRMS = jerkValues.length > 0 ? Math.sqrt(jerkValues.reduce((s, v) => s + v, 0) / jerkValues.length) : 0;

    // Harsh events: |a| > 2,78 м/с² (10 км/ч/с, §7.1/§7.2)
    const harshEvents = maneuvers.filter((m) => Math.abs(m.longA) > HARSH_THRESHOLD_MS2);

    // HSC: high-speed cornering — поворот >45° на скорости >60км/ч за 5 сек (§7.10)
    const hscEvents: Array<{ lat: number; lng: number; t: number; turnDeg: number; speed: number }> = [];
    for (let i = 5; i < maneuvers.length; i++) {
      const window = maneuvers.slice(i - 5, i + 1);
      // v2.13.0 (Ф3): 45° — как §7.10 и конвейер методологии (CORNERING_BEARING_DEG);
      // раньше 60° — events-роут занижал HSC против methodology.highSpeedCornering.
      const speedOk = window.every((m) => m.speed > HIGH_SPEED_CORNER_THRESHOLD);
      const totalTurn = window.reduce((s, m, idx) => (idx > 0 ? s + Math.abs(normAngle(m.bearing - window[idx - 1].bearing)) : 0), 0);
      if (speedOk && totalTurn > 45) {
        hscEvents.push({ lat: maneuvers[i].lat, lng: maneuvers[i].lng, t: maneuvers[i].t, turnDeg: Math.round(totalTurn), speed: maneuvers[i].speed });
      }
    }

    // G-G диаграмма: точки (longA, latA), нормированные на g (9.81 м/с²)
    const ggPoints = maneuvers.map((m) => ({
      x: Math.round((m.longA / 9.81) * 100) / 100,
      y: Math.round((m.latA / 9.81) * 100) / 100,
    }));

    // Кольца harsh-зон в G-G (0.2g, 0.4g, 0.6g)
    const ggRings = [0.2, 0.4, 0.6];

    return json(
      {
        sessionId: id,
        deviceId: session.deviceId,
        // Все манёвры для G-G точек
        maneuvers,
        // G-G диаграмма points (x=longA/g, y=latA/g)
        gg: { points: ggPoints, rings: ggRings },
        // Harsh events (|a| > 2,78 м/с² — §7.1/§7.2; комментарий v2.16.0: раньше тут
        // врал «> 10 м/с²» при пороге 2,78)
        harshEvents: harshEvents.map((e) => ({
          lat: e.lat,
          lng: e.lng,
          type: e.longA < 0 ? "braking" : "acceleration",
          longA: e.longA,
          t: e.t,
          speed: e.speed,
        })),
        // High-Speed Cornering events
        hscEvents,
        // Сводка
        summary: {
          accelerationRMS: Math.round(accelerationRMS * 100) / 100,
          jerkRMS: Math.round(jerkRMS * 100) / 100,
          harshBraking: harshEvents.filter((e) => e.longA < 0).length,
          harshAcceleration: harshEvents.filter((e) => e.longA > 0).length,
          maneuvers: maneuvers.length,
          hscCount: hscEvents.length,
        },
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (e) {
    // v2.16.0 (B2): наружу — только generic-текст (детали SQL/внутренностей —
    // в логи; было два роута из всех, что сыпали err.message клиенту)
    logger.error("events fetch failed", { requestId, error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
