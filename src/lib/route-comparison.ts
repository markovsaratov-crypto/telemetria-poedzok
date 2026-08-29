// src/lib/route-comparison.ts — сравнительные метрики по routeHash-группам (методология v2.9 §10.0–§10.6).
// Группировка концептуально одинаковых поездок по детерминированному routeHash (§10.0),
// агрегаты по ActiveDuration (§4.11), фильтр SessionReliability ≥ 0.6 (§10.1),
// Theil-Sen-тренд (§10.5), HotspotSegments P75 < 0.5 (§10.6).
import { libsql } from "./db";
import { computeActiveTrip, computeMovingTime, type MethodologyPoint, type ActiveTrip, type MotionResult } from "./active-trip";
import {
  computeRouteTrendTheilSen,
  computeHotspotSegments,
  computeSessionReliability,
  completenessScore,
  gaps as computeGaps,
  type RouteTrendResult,
  type HotspotSegment,
} from "./metrics-methodology";
import { haversineM } from "./geo";

export interface GroupSession {
  sessionId: string;
  deviceId: string;
  startTime: number; // мс
  endTime: number | null; // мс
  activeDuration: number; // сек (§4.11)
  activeStartTime: number; // мс — для бакетирования §10.3
  distanceM: number;
  reliability: number | null; // SessionReliability 0..1 (для фильтра ≥ 0.6)
  hasActiveTrip: boolean;
}

export interface RouteGroupInfo {
  routeHash: string;
  topologyHash: string | null;
  sessionCount: number;
  firstSeen: string; // ISO
  lastSeen: string; // ISO
  avgActiveDurationSec: number | null;
  bestActiveDurationSec: number | null;
  worstActiveDurationSec: number | null;
  stdDevActiveDurationSec: number | null;
  avgDistanceM: number | null;
  startCoord: { lat: number; lon: number } | null;
  endCoord: { lat: number; lon: number } | null;
  deviceIds: string[];
  sessionIds: string[];
}

const RELIABILITY_FLOOR = 0.6; // §10.1: в агрегат входят только сессии с SessionReliability ≥ 0.6

// libsql-совместимый парсер дат: MIN/MAX возвращают ISO-строки, прямой SELECT — epoch int/BigInt
function toMs(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  return new Date(s).getTime();
}

// Загружает сессии routeHash-группы с вычислением ActiveTrip + SessionReliability (§11.6).
// GPS-точки читаются напрямую через libsql (без db-обёрток — полный контроль над выборкой).
export async function loadGroupSessions(routeHash: string): Promise<GroupSession[]> {
  const sessRes = await libsql.execute({
    sql: "SELECT id, deviceId, startTime, endTime FROM Session WHERE routeHash = ? AND deletedAt IS NULL ORDER BY startTime ASC",
    args: [routeHash],
  });
  if (sessRes.rows.length === 0) return [];

  const out: GroupSession[] = [];
  for (const row of sessRes.rows) {
    const s = row as unknown as Record<string, unknown>;
    const sessionId = String(s.id);
    const ptsRes = await libsql.execute({
      sql: "SELECT lat, lon, speed, altitude, accuracy, bearing, timestamp FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
      args: [sessionId],
    });
    const points: MethodologyPoint[] = ptsRes.rows.map((r) => {
      const p = r as unknown as Record<string, unknown>;
      return {
        lat: Number(p.lat),
        lon: Number(p.lon),
        speed: p.speed == null ? null : Number(p.speed),
        altitude: p.altitude == null ? null : Number(p.altitude),
        accuracy: p.accuracy == null ? null : Number(p.accuracy),
        bearing: p.bearing == null ? null : Number(p.bearing),
        timestamp: Number(p.timestamp),
      };
    });
    if (points.length < 2) continue;

    const motion = computeMovingTime(points);
    const active: ActiveTrip = computeActiveTrip(points, motion);
    if (!active.hasActiveTrip) continue;

    // Дистанция по активной части
    let distanceM = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].timestamp < active.activeStartTime || points[i - 1].timestamp > active.activeEndTime) continue;
      distanceM += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }

    // SessionReliability §11.6 (полный расчёт, синхронный)
    const durationSec = Math.max(1, (points[points.length - 1].timestamp - points[0].timestamp) / 1000);
    const gap = computeGaps(points);
    const cs = completenessScore(gap.totalMs, durationSec);
    const relResult = computeSessionReliability(points, cs, motion);

    out.push({
      sessionId,
      deviceId: String(s.deviceId),
      startTime: toMs(s.startTime),
      endTime: s.endTime == null ? null : toMs(s.endTime),
      activeDuration: active.activeDuration,
      activeStartTime: active.activeStartTime,
      distanceM: Math.round(distanceM),
      reliability: relResult.value,
      hasActiveTrip: true,
    });
  }
  return out;
}

// === §10.1/§10.2: RouteAvg/Best/Worst/StdDev по activeDuration ===
export interface DurationStats {
  avg: number | null;
  best: number | null;
  worst: number | null;
  stdDev: number | null;
  eligibleCount: number; // сессии с reliability ≥ 0.6
  totalCount: number;
}

export function routeDurationStats(sessions: GroupSession[]): DurationStats {
  const eligible = sessions.filter((s) => s.reliability == null || s.reliability >= RELIABILITY_FLOOR);
  const pool = eligible.length > 0 ? eligible : sessions; // если все ненадёжны — показываем все с пометкой
  const durations = pool.map((s) => s.activeDuration);
  if (durations.length === 0) {
    return { avg: null, best: null, worst: null, stdDev: null, eligibleCount: 0, totalCount: sessions.length };
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.length > 1
    ? durations.reduce((a, b) => a + (b - avg) ** 2, 0) / (durations.length - 1)
    : 0;
  return {
    avg: Math.round(avg),
    best: Math.round(Math.min(...durations)),
    worst: Math.round(Math.max(...durations)),
    stdDev: Math.round(Math.sqrt(variance)),
    eligibleCount: eligible.length,
    totalCount: sessions.length,
  };
}

// === §10.3: RouteTrafficPattern — 8 бакетов по 3 часа (по ActiveStartTime) ===
export interface TrafficBucket {
  bucket: number; // 0..7 (0-3, 3-6, … 21-24)
  label: string; // "0–3", …
  avgActiveDurationSec: number | null;
  sessionCount: number;
}

const BUCKET_LABELS = ["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24"];

export function routeTrafficPattern(sessions: GroupSession[]): TrafficBucket[] {
  const buckets: { durations: number[] }[] = Array.from({ length: 8 }, () => ({ durations: [] }));
  for (const s of sessions) {
    const hour = new Date(s.activeStartTime).getHours();
    buckets[Math.floor(hour / 3)].durations.push(s.activeDuration);
  }
  return buckets.map((b, i) => ({
    bucket: i,
    label: BUCKET_LABELS[i],
    avgActiveDurationSec: b.durations.length > 0 ? Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length) : null,
    sessionCount: b.durations.length,
  }));
}

// === §10.4: RouteDayOfWeekPattern — по дням недели (по ActiveStartTime) ===
export interface DowBucket {
  dow: number; // 1..7 (пн..вс)
  label: string;
  avgActiveDurationSec: number | null;
  sessionCount: number;
}

const DOW_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function routeDayOfWeekPattern(sessions: GroupSession[]): DowBucket[] {
  const buckets: { durations: number[] }[] = Array.from({ length: 7 }, () => ({ durations: [] }));
  for (const s of sessions) {
    const jsDow = new Date(s.activeStartTime).getDay(); // 0=вс..6=сб
    const dow = jsDow === 0 ? 6 : jsDow - 1; // 0=пн..6=вс
    buckets[dow].durations.push(s.activeDuration);
  }
  return buckets.map((b, i) => ({
    dow: i + 1,
    label: DOW_LABELS[i],
    avgActiveDurationSec: b.durations.length > 0 ? Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length) : null,
    sessionCount: b.durations.length,
  }));
}

// === §10.5: RouteTrend (Theil-Sen) — переиспользует реализацию metrics-methodology ===
export function routeTrend(sessions: GroupSession[]): RouteTrendResult {
  return computeRouteTrendTheilSen(
    sessions.map((s) => ({ date: new Date(s.activeStartTime), activeDurationSec: s.activeDuration }))
  );
}

// === §10.6: HotspotSegments (P75 < 0.5) ===
// Сегментная модель: канонический полилайн из последнего завершённого TrafficJob группы;
// severity сегмента в сессии = фактическая скорость сегмента / плановая скорость.
// Фактическая — из GPS-точек сессии, привязанных к сегменту (ближайший, радиус снапа ~55 м).
const SNAP_RADIUS_M = 55; // snap-to-grid ~55 м (совпадает с кэшем маршрутизации)
const PLAN_BASELINE_KMH = 40; // §3.2: базовая линия гаверсинус/40 км/ч

export async function computeGroupHotspots(routeHash: string, sessions: GroupSession[]): Promise<{
  hotspots: HotspotSegment[];
  totalSegments: number;
  polyline: { lat: number; lon: number }[];
}> {
  // 1. Канонический полилайн — из последнего completed TrafficJob сессий группы
  let polyline: { lat: number; lon: number }[] = [];
  let planDurationSec: number | null = null;
  if (sessions.length > 0) {
    const ids = sessions.map((s) => s.sessionId);
    const placeholders = ids.map(() => "?").join(",");
    const jobRes = await libsql.execute({
      sql: `SELECT result FROM TrafficJob WHERE status = 'completed' AND result IS NOT NULL AND sessionId IN (${placeholders}) ORDER BY updatedAt DESC LIMIT 1`,
      args: ids as never[],
    });
    if (jobRes.rows.length > 0) {
      try {
        const parsed = JSON.parse(String(jobRes.rows[0]));
        if (Array.isArray(parsed.segments)) {
          polyline = parsed.segments.map((sg: { lat: number; lon: number }) => ({ lat: Number(sg.lat), lon: Number(sg.lon) }));
        }
        if (typeof parsed.planDurationSec === "number") planDurationSec = parsed.planDurationSec;
      } catch { /* битый result — fallback ниже */ }
    }
  }

  // Fallback: полилайн из активных частей сессий (первая сессия группы)
  if (polyline.length < 2 && sessions.length > 0) {
    const ptsRes = await libsql.execute({
      sql: "SELECT lat, lon, timestamp FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
      args: [sessions[0].sessionId],
    });
    polyline = ptsRes.rows.map((r) => {
      const p = r as unknown as Record<string, unknown>;
      return { lat: Number(p.lat), lon: Number(p.lon) };
    });
    // прореживание до ~40 точек
    if (polyline.length > 40) {
      const step = Math.ceil(polyline.length / 40);
      polyline = polyline.filter((_, i) => i % step === 0 || i === polyline.length - 1);
    }
  }
  if (polyline.length < 2) return { hotspots: [], totalSegments: 0, polyline: [] };

  // 2. Сегменты канонического полилайна: дистанция + плановая скорость
  const segs: { id: string; a: { lat: number; lon: number }; b: { lat: number; lon: number }; distanceM: number; planSpeedKmh: number }[] = [];
  let totalLen = 0;
  for (let i = 1; i < polyline.length; i++) {
    const d = haversineM(polyline[i - 1].lat, polyline[i - 1].lon, polyline[i].lat, polyline[i].lon);
    if (d < 5) continue; // джиттер-точки
    totalLen += d;
    segs.push({ id: `s${i - 1}`, a: polyline[i - 1], b: polyline[i], distanceM: d, planSpeedKmh: PLAN_BASELINE_KMH });
  }
  // Если провайдер дал план по времени — пропорционально распределить плановую скорость
  if (planDurationSec != null && planDurationSec > 0 && totalLen > 0) {
    const avgPlanKmh = (totalLen / 1000) / (planDurationSec / 3600);
    for (const sg of segs) sg.planSpeedKmh = Math.max(5, avgPlanKmh);
  }

  // 3. Фактические скорости: GPS-точки сессий → ближайшие сегменты
  const severityHist = new Map<string, number[]>();
  for (const s of sessions) {
    const ptsRes = await libsql.execute({
      sql: "SELECT lat, lon, speed, timestamp FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
      args: [s.sessionId],
    });
    const points = ptsRes.rows.map((r) => {
      const p = r as unknown as Record<string, unknown>;
      return { lat: Number(p.lat), lon: Number(p.lon), speed: p.speed == null ? null : Number(p.speed), timestamp: Number(p.timestamp) };
    });
    if (points.length < 2) continue;

    // Раскладываем точки по сегментам (ближайший в радиусе снапа)
    const segPoints = new Map<number, { lat: number; lon: number; timestamp: number }[]>();
    for (const p of points) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let si = 0; si < segs.length; si++) {
        const sg = segs[si];
        // расстояние точки до сегмента (приближение: до середины + до концов)
        const mid = { lat: (sg.a.lat + sg.b.lat) / 2, lon: (sg.a.lon + sg.b.lon) / 2 };
        const d = Math.min(
          haversineM(p.lat, p.lon, sg.a.lat, sg.a.lon),
          haversineM(p.lat, p.lon, sg.b.lat, sg.b.lon),
          haversineM(p.lat, p.lon, mid.lat, mid.lon)
        );
        if (d < bestDist) { bestDist = d; bestIdx = si; }
      }
      if (bestIdx >= 0 && bestDist <= SNAP_RADIUS_M) {
        const arr = segPoints.get(bestIdx) || [];
        arr.push({ lat: p.lat, lon: p.lon, timestamp: p.timestamp });
        segPoints.set(bestIdx, arr);
      }
    }

    // Скорость сегмента: дистанция между первой/последней точкой / время
    for (const si of Array.from(segPoints.keys())) {
      const pts = segPoints.get(si)!;
      if (pts.length < 2) continue;
      const sg = segs[si];
      const first = pts[0];
      const last = pts[pts.length - 1];
      const dtSec = (last.timestamp - first.timestamp) / 1000;
      if (dtSec <= 1) continue;
      const dM = haversineM(first.lat, first.lon, last.lat, last.lon);
      const actualKmh = (dM / 1000) / (dtSec / 3600);
      if (actualKmh > 150) continue; // выброс (GPS-телепорт)
      const severity = Math.min(1, actualKmh / sg.planSpeedKmh);
      const arr = severityHist.get(sg.id) || [];
      arr.push(Math.round(severity * 1000) / 1000);
      severityHist.set(sg.id, arr);
    }
  }

  const history = Array.from(severityHist.entries()).map(([segmentId, severities]) => ({ segmentId, severities }));
  const hotspots = computeHotspotSegments(history).sort((a, b) => a.p75 - b.p75); // по «тяжести» §10.6
  return { hotspots, totalSegments: segs.length, polyline };
}

// === Список всех групп (для UI) ===
export async function listRouteGroups(): Promise<RouteGroupInfo[]> {
  const res = await libsql.execute(`
    SELECT routeHash, topologyHash, COUNT(*) as cnt,
           MIN(startTime) as firstSeen, MAX(startTime) as lastSeen,
           GROUP_CONCAT(DISTINCT deviceId) as devices,
           GROUP_CONCAT(id) as ids
    FROM Session
    WHERE routeHash IS NOT NULL AND deletedAt IS NULL
    GROUP BY routeHash
    ORDER BY lastSeen DESC
  `);
  const groups: RouteGroupInfo[] = [];
  for (const row of res.rows) {
    const r = row as unknown as Record<string, unknown>;
    const routeHash = String(r.routeHash);
    const ids = String(r.ids || "").split(",").filter(Boolean);
    const firstSeen = toMs(r.firstSeen);
    const lastSeen = toMs(r.lastSeen);
    const info: RouteGroupInfo = {
      routeHash,
      topologyHash: r.topologyHash == null ? null : String(r.topologyHash),
      sessionCount: Number(r.cnt),
      firstSeen: new Date(firstSeen).toISOString(),
      lastSeen: new Date(lastSeen).toISOString(),
      avgActiveDurationSec: null,
      bestActiveDurationSec: null,
      worstActiveDurationSec: null,
      stdDevActiveDurationSec: null,
      avgDistanceM: null,
      startCoord: null,
      endCoord: null,
      deviceIds: String(r.devices || "").split(",").filter(Boolean),
      sessionIds: ids,
    };
    // Детали (ActiveTrip-агрегаты) — только для групп ≤ 12 сессий, чтобы endpoint оставался лёгким
    if (ids.length > 0 && ids.length <= 12) {
      const sessions = await loadGroupSessions(routeHash);
      const stats = routeDurationStats(sessions);
      info.avgActiveDurationSec = stats.avg;
      info.bestActiveDurationSec = stats.best;
      info.worstActiveDurationSec = stats.worst;
      info.stdDevActiveDurationSec = stats.stdDev;
      info.avgDistanceM = sessions.length > 0 ? Math.round(sessions.reduce((a, s) => a + s.distanceM, 0) / sessions.length) : null;
      if (sessions.length > 0) {
        // Старт/финиш первой сессии группы (для мини-карты/подписи)
        const ptsRes = await libsql.execute({
          sql: "SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC LIMIT 1",
          args: [sessions[0].sessionId],
        });
        if (ptsRes.rows.length > 0) {
          const p = ptsRes.rows[0] as unknown as Record<string, unknown>;
          info.startCoord = { lat: Number(p.lat), lon: Number(p.lon) };
        }
        const ptsRes2 = await libsql.execute({
          sql: "SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp DESC LIMIT 1",
          args: [sessions[sessions.length - 1].sessionId],
        });
        if (ptsRes2.rows.length > 0) {
          const p = ptsRes2.rows[0] as unknown as Record<string, unknown>;
          info.endCoord = { lat: Number(p.lat), lon: Number(p.lon) };
        }
      }
    }
    groups.push(info);
  }
  return groups;
}

// === Сравнение конкретной сессии с её группой (route-comparison endpoint) ===
export interface RouteComparison {
  sessionId: string;
  routeHash: string;
  groupSize: number;
  stats: DurationStats;
  sessionActiveDurationSec: number;
  rank: number | null; // 1 = лучшая (самая быстрая)
  percentile: number | null; // 0..100 (позиция в группе)
  vsAvgPct: number | null; // % отклонения от среднего
  trafficPattern: TrafficBucket[];
  dayOfWeekPattern: DowBucket[];
  trend: RouteTrendResult;
  history: { sessionId: string; date: string; activeDurationSec: number; deviceId: string }[];
}

export async function compareSessionWithGroup(sessionId: string): Promise<RouteComparison | null> {
  const sessRes = await libsql.execute({
    sql: "SELECT id, routeHash FROM Session WHERE id = ? AND deletedAt IS NULL",
    args: [sessionId],
  });
  if (sessRes.rows.length === 0) return null;
  const routeHash = (sessRes.rows[0] as unknown as Record<string, unknown>).routeHash;
  if (!routeHash) return null;

  const sessions = await loadGroupSessions(String(routeHash));
  const me = sessions.find((s) => s.sessionId === sessionId);
  if (!me) return null;

  const stats = routeDurationStats(sessions);
  const durations = [...sessions].sort((a, b) => a.activeDuration - b.activeDuration);
  const rank = durations.findIndex((s) => s.sessionId === sessionId) + 1;
  const percentile = durations.length > 1 ? Math.round(((rank - 1) / (durations.length - 1)) * 100) : null;
  const vsAvgPct = stats.avg != null && stats.avg > 0
    ? Math.round(((me.activeDuration - stats.avg) / stats.avg) * 1000) / 10
    : null;

  return {
    sessionId,
    routeHash: String(routeHash),
    groupSize: sessions.length,
    stats,
    sessionActiveDurationSec: Math.round(me.activeDuration),
    rank: rank > 0 ? rank : null,
    percentile,
    vsAvgPct,
    trafficPattern: routeTrafficPattern(sessions),
    dayOfWeekPattern: routeDayOfWeekPattern(sessions),
    trend: routeTrend(sessions),
    history: [...sessions]
      .sort((a, b) => a.activeStartTime - b.activeStartTime)
      .map((s) => ({
        sessionId: s.sessionId,
        date: new Date(s.activeStartTime).toISOString(),
        activeDurationSec: Math.round(s.activeDuration),
        deviceId: s.deviceId,
      })),
  };
}
