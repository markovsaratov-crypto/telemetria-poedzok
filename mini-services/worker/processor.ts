// processor.ts — обработка одной TrafficJob (§3.3, §3.2).
//
// v2.9: расширена логика:
//   1. Строит маршрут через chain (2ГИС → OSRM → haversine) — без изменений
//   2. Вычисляет ActiveTrip + новые поведенческие метрики (AccelerationRMS, JerkRMS, ...)
//   3. Считает routeHash через topologyHash (snap-to-grid, §10.0)
//   4. Запускает HMM map matching (Viterbi, §17.2) если есть segments
//
// ИЗОЛЯЦИЯ (§9.6 anti-pattern: shared event loop): Worker не импортирует
// основной проект. Логика chain маршрутизации (2ГИС → OSRM → haversine)
// и circuit-breaker скопирована из src/lib/routing/{chain,circuit-breaker}.ts
// и адаптирована под worker-local env.

import { createHash } from "crypto";

// === Types ===

export interface RouteSegment {
  lat: number;
  lon: number;
  bearing?: number | null;
  distanceM?: number;
  durationSec?: number;
  planSpeedKmh?: number;
  trafficSpeedKmh?: number;
  trafficDurationSec?: number;
  trafficSource?: string;
  trafficUtc?: string;
}

export interface RouteResult {
  provider: "2gis" | "osrm" | "haversine";
  distanceM: number;
  durationSec: number;
  segments: RouteSegment[];
  trafficFetched: boolean;
  trafficUtc?: string;
  // v2.9: новые поля, вычисляемые после маршрутизации
  routeHash?: string | null;
  topologyHash?: string | null;
  metrics?: WorkerMethodologyMetrics;
  mapMatchLogProb?: number;
}

export interface MethodologyPointLike {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null;
  timestamp: number; // мс
}

// Сводка v2.9 метрик, вычисленных в ворчере (для сохранения в TrafficJob.result)
export interface WorkerMethodologyMetrics {
  activeTrip: {
    hasActiveTrip: boolean;
    activeDuration: number;
    preTripIdle: number;
    postTripIdle: number;
    activeIdleTime: number;
  };
  movingTime: number;
  idleTime: number;
  gapTime: number;
  ecoScore: {
    value: number | null;
    rating: string;
    baselineVersion: string;
  };
  accelerationRms: number | null;
  jerkRms: number | null;
  speedConsistencyIndex: number | null;
  bearingConsistency: number | null;
  uTurnCount: number;
  turnCount: number;
  highSpeedCornering: number;
  sessionReliability: {
    value: number | null;
    rating: string;
  };
}

/**
 * Форма TrafficJob, получаемого от POST /api/worker/poll.
 * Соответствует prisma schema: TrafficJob + session.gpsPoints (ordered asc by timestamp).
 * v2.9: добавлен bearing в gpsPoints.
 */
export interface TrafficJobLike {
  id: string;
  sessionId: string;
  session: {
    id: string;
    deviceId: string;
    gpsPoints: Array<{
      lat: number;
      lon: number;
      speed?: number | null;
      altitude?: number | null;
      accuracy?: number | null;
      bearing?: number | null;
      timestamp?: bigint | number | string;
    }>;
  };
}

// === Worker-local env readers (NO main project imports) ===

function envNumber(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envString(key: string, def = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
}

// === Circuit breaker (копия src/lib/routing/circuit-breaker.ts) ===

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

function checkCircuit(provider: string): boolean {
  const s = circuits.get(provider);
  if (!s) return true;
  if (Date.now() < s.openUntil) return false;
  return true;
}

function recordFailure(provider: string): void {
  const threshold = envNumber("CIRCUIT_BREAKER_THRESHOLD", 5);
  const timeoutSec = envNumber("CIRCUIT_BREAKER_TIMEOUT_SEC", 30);
  const s = circuits.get(provider) || { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= threshold) {
    s.openUntil = Date.now() + timeoutSec * 1000;
  }
  circuits.set(provider, s);
}

function recordSuccess(provider: string): void {
  circuits.set(provider, { failures: 0, openUntil: 0 });
}

// === Haversine (§3.2 last resort, 40 км/ч) ===

const EARTH_R = 6371000;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// === 2ГИС (primary, traffic-aware) ===

async function route2Gis(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult | null> {
  const key = envString("TWO_GIS_API_KEY");
  if (!key) return null;
  if (!checkCircuit("2gis")) return null;
  try {
    // R5.1: align with src/lib/routing/chain.ts — routing.api.2gis.ru is dead,
    // use catalog.api.2gis.ru (works globally with the configured key).
    // Optional Cloudflare Worker proxy override via TWO_GIS_PROXY_URL.
    const proxyUrl = envString("TWO_GIS_PROXY_URL");
    const baseUrl = proxyUrl || "https://catalog.api.2gis.ru";
    const url = `${baseUrl}/carrouting/6.0.0/global?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          { lat: startLat, lon: startLon },
          { lat: endLat, lon: endLon },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      recordFailure("2gis");
      return null;
    }
    const data = (await res.json()) as {
      result?: Array<{
        total_distance?: number;
        total_duration?: number;
        algorithm?: string;
        maneuvers?: Array<{
          outcoming_path?:
            | {
                distance?: number;
                duration?: number;
                geometry?: Array<{ selection?: string }>;
              }
            | Array<{
                distance?: number;
                duration?: number;
                geometry?: Array<{ selection?: string }>;
              }>;
        }>;
      }>;
    };
    if (!data.result || !data.result.length) {
      recordFailure("2gis");
      return null;
    }
    const route = data.result[0];
    const distanceM = Number(route.total_distance) || 0;
    const durationSec = Number(route.total_duration) || 0;
    // R5.1: parse maneuvers[].outcoming_path.geometry[].selection LINESTRING
    // (same as src/lib/routing/chain.ts). Normalise to array — 2ГИС может
    // отдать как один объект, так и массив путей под одним манёвром.
    const segments: RouteSegment[] = [];
    const maneuvers = route.maneuvers || [];
    for (const m of maneuvers) {
      const rawPaths = m.outcoming_path;
      const paths: Array<{
        distance?: number;
        duration?: number;
        geometry?: Array<{ selection?: string }>;
      }> = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];
      for (const path of paths) {
        const pathDistance = Number(path.distance) || 0;
        const pathDuration = Number(path.duration) || 0;
        const geometry = path.geometry || [];
        const pathCoords: Array<{ lat: number; lon: number }> = [];
        for (const g of geometry) {
          if (g.selection) {
            const coords = g.selection
              .replace("LINESTRING(", "")
              .replace(")", "")
              .split(",");
            for (const c of coords) {
              const [lon, lat] = c.trim().split(" ").map(Number);
              if (!isNaN(lat) && !isNaN(lon)) {
                pathCoords.push({ lat, lon });
              }
            }
          }
        }
        const n = pathCoords.length;
        if (n === 0) continue;
        const perDist = pathDistance / n;
        const perDur = pathDuration / n;
        for (const { lat, lon } of pathCoords) {
          segments.push({
            lat,
            lon,
            distanceM: Math.round(perDist * 100) / 100,
            durationSec: Math.round(perDur * 100) / 100,
            planSpeedKmh: perDur > 0 ? Math.round((perDist / perDur) * 3.6 * 10) / 10 : undefined,
            trafficSpeedKmh: perDur > 0 ? Math.round((perDist / perDur) * 3.6 * 10) / 10 : undefined,
            trafficSource: "2gis",
          });
        }
      }
    }
    recordSuccess("2gis");
    return {
      provider: "2gis",
      distanceM,
      durationSec,
      segments,
      trafficFetched: true,
      trafficUtc: new Date().toISOString(),
    };
  } catch {
    recordFailure("2gis");
    return null;
  }
}

// === OSRM (fallback, без пробок) ===

async function routeOsrm(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult | null> {
  if (!checkCircuit("osrm")) return null;
  try {
    const base = envString("OSRM_BASE_URL", "https://router.project-osrm.org");
    const url = `${base}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      recordFailure("osrm");
      return null;
    }
    const data = (await res.json()) as {
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    if (!data.routes || !data.routes.length) {
      recordFailure("osrm");
      return null;
    }
    const r = data.routes[0];
    const coords: [number, number][] = (r.geometry?.coordinates || []).map(
      (c) => [c[1], c[0]] // geojson [lon, lat] → [lat, lon]
    );
    const segments: RouteSegment[] = coords.map(([lat, lon]) => ({ lat, lon }));
    recordSuccess("osrm");
    return {
      provider: "osrm",
      distanceM: r.distance || 0,
      durationSec: r.duration || 0,
      segments,
      trafficFetched: false,
    };
  } catch {
    recordFailure("osrm");
    return null;
  }
}

// === Haversine (last resort) ===

function routeHaversine(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): RouteResult {
  const distanceM = haversine(startLat, startLon, endLat, endLon);
  const durationSec = Math.round(((distanceM / 1000) / 40) * 3600); // 40 км/ч
  return {
    provider: "haversine",
    distanceM,
    durationSec,
    segments: [
      { lat: startLat, lon: startLon },
      { lat: endLat, lon: endLon },
    ],
    trafficFetched: false,
  };
}

// === Chain: 2ГИС → OSRM → haversine (§3.2) ===

export async function routeRequest(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult> {
  const r1 = await route2Gis(startLat, startLon, endLat, endLon);
  if (r1) return r1;
  const r2 = await routeOsrm(startLat, startLon, endLat, endLon);
  if (r2) return r2;
  return routeHaversine(startLat, startLon, endLat, endLon);
}

// === v2.9: state machine (§4.6) — вычисление MovingTime/IdleTime/GapTime/states ===

type MotionState = "idle" | "moving" | "gap";
interface MotionResult {
  movingTime: number;
  idleTime: number;
  gapTime: number;
  states: MotionState[];
}

const KMH_TO_MS = 1 / 3.6;

function computeMovingTime(points: MethodologyPointLike[]): MotionResult {
  const MOVING_START = envNumber("MOVING_TIME_HYSTERESIS_HIGH_KMH", 5) * KMH_TO_MS;
  const MOVING_STOP = envNumber("MOVING_TIME_HYSTERESIS_LOW_KMH", 2) * KMH_TO_MS;
  const MIN_STATE_DURATION = envNumber("MOVING_TIME_DEBOUNCE_SEC", 5);
  const GAP_THRESHOLD_SEC = envNumber("MOVING_TIME_GAP_SEC", 30);

  if (points.length < 2) {
    return { movingTime: 0, idleTime: 0, gapTime: 0, states: [] };
  }

  interface Interval {
    dt: number;
    v: number;
    isGap: boolean;
  }
  const intervals: Interval[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0) {
      intervals.push({ dt: 0, v: 0, isGap: false });
      continue;
    }
    if (dt > GAP_THRESHOLD_SEC) {
      intervals.push({ dt, v: 0, isGap: true });
      continue;
    }
    const dispSpeed = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / dt;
    const driftThreshold = (points[i].accuracy ?? 0) / dt;
    let v: number;
    if (dispSpeed < driftThreshold) {
      v = 0;
    } else if (points[i].speed != null && points[i].speed! >= 0) {
      v = Math.min(points[i].speed!, dispSpeed * 1.5);
    } else {
      v = dispSpeed;
    }
    intervals.push({ dt, v, isGap: false });
  }

  // Smoothing по окну 3 (медиана)
  const n = intervals.length;
  const smoothed: number[] = intervals.map((it) => it.v);
  const median3 = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 1 ? s[0] : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  for (let i = 0; i < n; i++) {
    if (intervals[i].isGap) continue;
    const win: number[] = [intervals[i].v];
    for (let j = i - 1; j >= 0; j--) { if (!intervals[j].isGap) { win.push(intervals[j].v); break; } }
    for (let j = i + 1; j < n; j++) { if (!intervals[j].isGap) { win.push(intervals[j].v); break; } }
    smoothed[i] = median3(win);
  }

  // State machine
  const states: MotionState[] = new Array(n).fill("idle");
  let confirmed: "idle" | "moving" = "idle";
  let candidate: "idle" | "moving" | null = null;
  let candidateDur = 0;

  for (let i = 0; i < n; i++) {
    const it = intervals[i];
    if (it.isGap) {
      states[i] = "gap";
      candidate = null;
      candidateDur = 0;
      continue;
    }
    const v = smoothed[i];
    const target: "idle" | "moving" = v >= MOVING_START ? "moving" : (v < MOVING_STOP ? "idle" : confirmed);
    if (target === confirmed) {
      candidate = null;
      candidateDur = 0;
      states[i] = confirmed;
    } else {
      if (candidate === target) candidateDur += it.dt;
      else { candidate = target; candidateDur = it.dt; }
      if (candidateDur >= MIN_STATE_DURATION) {
        confirmed = target;
        candidate = null;
        candidateDur = 0;
      }
      states[i] = confirmed;
    }
  }

  let movingTime = 0, idleTime = 0, gapTime = 0;
  for (let i = 0; i < n; i++) {
    const dt = intervals[i].dt;
    if (states[i] === "moving") movingTime += dt;
    else if (states[i] === "idle") idleTime += dt;
    else gapTime += dt;
  }
  return { movingTime, idleTime, gapTime, states };
}

// === v2.9 §4.11 ActiveTrip ===

interface ActiveTripResult {
  hasActiveTrip: boolean;
  activeStartTime: number;
  activeEndTime: number;
  activeDuration: number;
  activeStartCoord: { lat: number; lon: number } | null;
  activeEndCoord: { lat: number; lon: number } | null;
  preTripIdle: number;
  postTripIdle: number;
  activeIdleTime: number;
}

function computeActiveTrip(points: MethodologyPointLike[], motion: MotionResult): ActiveTripResult {
  const firstMoving = motion.states.findIndex((s) => s === "moving");
  const lastMoving = motion.states.reduce<number>((acc, s, i) => (s === "moving" ? i : acc), -1);

  if (firstMoving === -1 || points.length === 0) {
    return {
      hasActiveTrip: false,
      activeStartTime: 0,
      activeEndTime: 0,
      activeDuration: 0,
      activeStartCoord: null,
      activeEndCoord: null,
      preTripIdle: 0,
      postTripIdle: 0,
      activeIdleTime: 0,
    };
  }

  const startIdx = firstMoving;
  const endIdx = lastMoving + 1;
  const startTs = points[startIdx].timestamp;
  const endTs = points[endIdx].timestamp;
  const firstTs = points[0].timestamp;
  const lastTs = points[points.length - 1].timestamp;
  const pre = (startTs - firstTs) / 1000;
  const post = (lastTs - endTs) / 1000;

  return {
    hasActiveTrip: true,
    activeStartTime: startTs,
    activeEndTime: endTs,
    activeDuration: (endTs - startTs) / 1000,
    activeStartCoord: { lat: points[startIdx].lat, lon: points[startIdx].lon },
    activeEndCoord: { lat: points[endIdx].lat, lon: points[endIdx].lon },
    preTripIdle: pre,
    postTripIdle: post,
    activeIdleTime: Math.max(0, motion.idleTime - pre - post),
  };
}

// === v2.9 §7.3-§7.10: поведенческие метрики ===

function computeAccelerationRMS(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  let sumSq = 0, sumDt = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const v0 = points[i - 1].speed, v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) continue;
    const a = (v1 - v0) / dt;
    sumSq += a * a * dt;
    sumDt += dt;
  }
  if (sumDt === 0) return null;
  return Math.round(Math.sqrt(sumSq / sumDt) * 1000) / 1000;
}

function computeJerkRMS(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  let sumSq = 0, sumDt = 0;
  let prevA: number | null = null;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) { prevA = null; continue; }
    const v0 = points[i - 1].speed, v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) { prevA = null; continue; }
    const a = (v1 - v0) / dt;
    if (prevA != null) {
      const j = (a - prevA) / dt;
      sumSq += j * j * dt;
      sumDt += dt;
    }
    prevA = a;
  }
  if (sumDt === 0) return null;
  return Math.round(Math.sqrt(sumSq / sumDt) * 1000) / 1000;
}

function computeSpeedConsistencyIndex(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  const speeds: number[] = [];
  for (const p of points) {
    if (p.timestamp < activeTrip.activeStartTime || p.timestamp > activeTrip.activeEndTime) continue;
    if (p.speed != null && p.speed >= 0) speeds.push(p.speed);
  }
  if (speeds.length < 2) return null;
  let n = 0, mean = 0, M2 = 0;
  for (const s of speeds) {
    n++;
    const delta = s - mean;
    mean += delta / n;
    M2 += delta * (s - mean);
  }
  if (n === 0 || mean === 0) return null;
  const stddev = Math.sqrt(M2 / n);
  return Math.round(Math.max(0, 1 - Math.min(1, stddev / mean)) * 1000) / 1000;
}

function computeBearingConsistency(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    deltas.push(Math.min(raw, 360 - raw));
  }
  if (deltas.length < 2) return null;
  let n = 0, mean = 0, M2 = 0;
  for (const d of deltas) {
    n++;
    const delta = d - mean;
    mean += delta / n;
    M2 += delta * (d - mean);
  }
  const stddev = Math.sqrt(M2 / n);
  return Math.round(Math.max(0, 1 - stddev / 180) * 1000) / 1000;
}

function computeUTurnCount(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 10) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 10) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    if (Math.min(raw, 360 - raw) > 150) count++;
  }
  return count;
}

function computeTurnCount(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const d = Math.min(raw, 360 - raw);
    if (d > 30 && d <= 150) count++;
  }
  return count;
}

function computeHighSpeedCornering(points: MethodologyPointLike[], activeTrip: ActiveTripResult): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 60) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    if (Math.min(raw, 360 - raw) > 45) count++;
  }
  return count;
}

// === v2.9 §7.3 CAP EcoScore (упрощённая версия для ворчера — без калибровки корпуса) ===

function computeEcoScoreCAP(
  points: MethodologyPointLike[],
  distanceM: number,
  activeTrip: ActiveTripResult
): { value: number | null; rating: string; baselineVersion: string } {
  const BRAKING_BASE = 0.5;
  const ACCEL_BASE = 0.4;
  const JERK_BASE = 0.3;

  if (!activeTrip.hasActiveTrip || distanceM < 500 || activeTrip.activeDuration < 60 || points.length < 60) {
    return { value: null, rating: "insufficient_data", baselineVersion: "default" };
  }

  let brakingEnergy = 0, accelEnergy = 0, jerkEnergy = 0;
  let prevA: number | null = null;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) { prevA = null; continue; }
    const v0 = points[i - 1].speed, v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) { prevA = null; continue; }
    const a = (v1 - v0) / dt;
    const aSq = a * a * dt;
    if (a < 0) brakingEnergy += aSq;
    else if (a > 0) accelEnergy += aSq;
    if (prevA != null) {
      const j = (a - prevA) / dt;
      jerkEnergy += j * j * dt;
    }
    prevA = a;
  }

  const distKm = distanceM / 1000;
  const brakingRate = brakingEnergy / distKm;
  const accelRate = accelEnergy / distKm;
  const jerkRate = jerkEnergy / distKm;

  const penalty = (actual: number, baseline: number): number => {
    if (baseline <= 0) return 1;
    const ratio = actual / baseline;
    return 1 - 1 / (1 + Math.pow(ratio, 1.5));
  };

  let value = 100 * (1 - 0.45 * penalty(brakingRate, BRAKING_BASE) - 0.30 * penalty(accelRate, ACCEL_BASE) - 0.25 * penalty(jerkRate, JERK_BASE));
  value = Math.max(0, Math.min(100, value));
  let rating = "low";
  if (value >= 80) rating = "high";
  else if (value >= 60) rating = "medium";
  return { value: Math.round(value * 10) / 10, rating, baselineVersion: "default" };
}

// === v2.9 §11.6 SessionReliability (упрощённая версия для ворчера) ===

function computeAvgAccuracy(points: MethodologyPointLike[]): number {
  let sum = 0, n = 0;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy >= 0) {
      sum += p.accuracy;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function computeSessionReliability(
  points: MethodologyPointLike[],
  completeness: number,
  motion: MotionResult
): { value: number | null; rating: string } {
  if (points.length < 2) return { value: null, rating: "insufficient_data" };
  const avgAcc = computeAvgAccuracy(points);
  let drift = 0;
  for (let i = 1; i < points.length; i++) {
    if (motion.states[i - 1] === "idle") {
      const disp = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      if (disp > drift) drift = disp;
    }
  }
  const driftScore = avgAcc > 0 ? Math.max(0, 1 - drift / avgAcc) : 1.0;
  const value = Math.max(0, Math.min(1, completeness * driftScore));
  let rating = "unreliable";
  if (value >= 0.85) rating = "high";
  else if (value >= 0.6) rating = "medium";
  else if (value >= 0.3) rating = "low";
  return { value: Math.round(value * 1000) / 1000, rating };
}

// === v2.9 §10.0 routeHash + topologyHash (snap-to-grid) ===

function snapToGrid(coord: { lat: number; lon: number }, step: number) {
  return {
    lat: Math.round(coord.lat / step) * step,
    lon: Math.round(coord.lon / step) * step,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function computeRouteHash(
  activeStartCoord: { lat: number; lon: number } | null,
  activeEndCoord: { lat: number; lon: number } | null,
  segments: RouteSegment[]
): { routeHash: string | null; topologyHash: string | null } {
  if (!activeStartCoord || !activeEndCoord) {
    return { routeHash: null, topologyHash: null };
  }
  const GRID_STEP = envNumber("ROUTE_ID_SNAP_GRID_DEG", 0.0005);
  const startGrid = snapToGrid(activeStartCoord, GRID_STEP);
  const endGrid = snapToGrid(activeEndCoord, GRID_STEP);
  const keypoints: string[] = [`${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}`];

  if (segments.length === 0) {
    keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);
    const topologyHash = "no_segments";
    const routeSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:${topologyHash}`;
    return { routeHash: sha256(routeSource).slice(0, 16), topologyHash };
  }

  for (let i = 1; i < segments.length; i++) {
    const b0 = segments[i - 1].bearing;
    const b1 = segments[i].bearing;
    if (b0 != null && b1 != null) {
      const raw = Math.abs(b1 - b0);
      if (Math.min(raw, 360 - raw) > 60) {
        const grid = snapToGrid({ lat: segments[i].lat, lon: segments[i].lon }, GRID_STEP);
        keypoints.push(`${grid.lat.toFixed(4)},${grid.lon.toFixed(4)}`);
      }
    }
  }
  keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);
  const topologyHash = sha256(keypoints.join("|")).slice(0, 8);
  const routeSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:${topologyHash}`;
  return { routeHash: sha256(routeSource).slice(0, 16), topologyHash };
}

// === v2.9 §17.2 HMM map matching (Viterbi, упрощённая версия для ворчера) ===

function hmmMapMatch(
  points: MethodologyPointLike[],
  segments: RouteSegment[]
): { segmentPerPoint: (number | null)[]; avgLogProb: number } {
  if (points.length === 0 || segments.length === 0) {
    return { segmentPerPoint: new Array(points.length).fill(null), avgLogProb: -Infinity };
  }
  const sigma = envNumber("HMM_EMISSION_SIGMA_M", 5);
  const beta = envNumber("HMM_TRANSITION_BETA_M", 5);
  const gapMs = envNumber("MOVING_TIME_GAP_SEC", 30) * 1000;
  const N = points.length;
  const M = segments.length;
  const V: number[][] = Array.from({ length: N }, () => new Array<number>(M).fill(-Infinity));
  const back: number[][] = Array.from({ length: N }, () => new Array<number>(M).fill(-1));

  const logEmission = (d: number) => -0.5 * Math.log(2 * Math.PI * 2 * sigma * sigma) - d * d / (2 * sigma * sigma);
  const logTransition = (delta: number) => -Math.log(beta) - delta / beta;
  const distToSeg = (i: number, j: number) => haversine(points[i].lat, points[i].lon, segments[j].lat, segments[j].lon);

  for (let j = 0; j < M; j++) V[0][j] = logEmission(distToSeg(0, j));

  for (let i = 1; i < N; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (dt > gapMs) {
      for (let j = 0; j < M; j++) {
        V[i][j] = logEmission(distToSeg(i, j));
        back[i][j] = -1;
      }
      continue;
    }
    const disp = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    for (let k = 0; k < M; k++) {
      const emit = logEmission(distToSeg(i, k));
      let maxLogProb = -Infinity, bestPrev = -1;
      for (let j = 0; j < M; j++) {
        if (!isFinite(V[i - 1][j])) continue;
        const routeDist = haversine(segments[j].lat, segments[j].lon, segments[k].lat, segments[k].lon);
        const total = V[i - 1][j] + logTransition(Math.abs(routeDist - disp));
        if (total > maxLogProb) { maxLogProb = total; bestPrev = j; }
      }
      V[i][k] = emit + maxLogProb;
      back[i][k] = bestPrev;
    }
  }

  const segmentPerPoint: (number | null)[] = new Array(N).fill(null);
  let bestFinal = -1, maxFinal = -Infinity;
  for (let j = 0; j < M; j++) {
    if (V[N - 1][j] > maxFinal) { maxFinal = V[N - 1][j]; bestFinal = j; }
  }
  if (bestFinal === -1) return { segmentPerPoint, avgLogProb: -Infinity };
  segmentPerPoint[N - 1] = bestFinal;
  for (let i = N - 1; i > 0; i--) {
    const prev = segmentPerPoint[i];
    if (prev == null) continue;
    segmentPerPoint[i - 1] = back[i][prev] === -1 ? null : back[i][prev];
  }
  return { segmentPerPoint, avgLogProb: maxFinal / N };
}

// === v2.9: вычисление всех метрик и routeHash после маршрутизации ===

function computeAllMetrics(
  points: MethodologyPointLike[],
  distanceM: number,
  durationSec: number,
  segments: RouteSegment[]
): {
  metrics: WorkerMethodologyMetrics;
  routeHash: string | null;
  topologyHash: string | null;
  mapMatchLogProb: number;
} {
  const motion = computeMovingTime(points);
  const activeTrip = computeActiveTrip(points, motion);

  // CompletenessScore для SessionReliability
  let gapMs = 0;
  const gapThreshold = envNumber("MOVING_TIME_GAP_SEC", 30) * 1000;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (dt > gapThreshold) gapMs += dt - gapThreshold;
  }
  const completeness = durationSec > 0 ? Math.max(0, Math.min(1, 1 - gapMs / (durationSec * 1000))) : 1.0;

  const eco = computeEcoScoreCAP(points, distanceM, activeTrip);
  const srel = computeSessionReliability(points, completeness, motion);

  const metrics: WorkerMethodologyMetrics = {
    activeTrip: {
      hasActiveTrip: activeTrip.hasActiveTrip,
      activeDuration: Math.round(activeTrip.activeDuration * 10) / 10,
      preTripIdle: Math.round(activeTrip.preTripIdle * 10) / 10,
      postTripIdle: Math.round(activeTrip.postTripIdle * 10) / 10,
      activeIdleTime: Math.round(activeTrip.activeIdleTime * 10) / 10,
    },
    movingTime: Math.round(motion.movingTime * 10) / 10,
    idleTime: Math.round(motion.idleTime * 10) / 10,
    gapTime: Math.round(motion.gapTime * 10) / 10,
    ecoScore: eco,
    accelerationRms: computeAccelerationRMS(points, activeTrip),
    jerkRms: computeJerkRMS(points, activeTrip),
    speedConsistencyIndex: computeSpeedConsistencyIndex(points, activeTrip),
    bearingConsistency: computeBearingConsistency(points, activeTrip),
    uTurnCount: computeUTurnCount(points, activeTrip),
    turnCount: computeTurnCount(points, activeTrip),
    highSpeedCornering: computeHighSpeedCornering(points, activeTrip),
    sessionReliability: srel,
  };

  const { routeHash, topologyHash } = computeRouteHash(
    activeTrip.activeStartCoord,
    activeTrip.activeEndCoord,
    segments
  );

  // HMM map matching — только если есть segments
  let mapMatchLogProb = -Infinity;
  if (segments.length > 0 && activeTrip.hasActiveTrip) {
    const hmm = hmmMapMatch(points, segments);
    mapMatchLogProb = hmm.avgLogProb;
  }

  return { metrics, routeHash, topologyHash, mapMatchLogProb };
}

// === processJob — обработка одной TrafficJob ===

/**
 * Берёт первую и последнюю GPS-точку session.gpsPoints, строит маршрут
 * через chain (2ГИС → OSRM → haversine).
 *
 * v2.9: после маршрутизации вычисляет:
 *   - ActiveTrip + state machine MovingTime/IdleTime/GapTime
 *   - Все поведенческие метрики (AccelerationRMS, JerkRMS, ...)
 *   - CAP EcoScore
 *   - SessionReliability
 *   - routeHash + topologyHash (snap-to-grid, §10.0)
 *   - HMM map matching (Viterbi, §17.2)
 *
 * Retry логика: 3 попытки с exponential backoff — делегирована API
 * (через status="failed", см. /api/worker/complete). processor делает 1 попытку
 * с timeout 8 сек.
 *
 * Edge cases:
 *   - < 2 точек → haversine результат с distanceM=0, routeHash=null
 *   - timeout 8 сек → throw (caller помечает job как "failed")
 */
export async function processJob(job: TrafficJobLike): Promise<RouteResult> {
  const points = job.session.gpsPoints;

  // Edge case: меньше 2 точек
  if (!points || points.length === 0) {
    return {
      provider: "haversine",
      distanceM: 0,
      durationSec: 0,
      segments: [],
      trafficFetched: false,
      routeHash: null,
      topologyHash: null,
    };
  }
  if (points.length === 1) {
    return {
      provider: "haversine",
      distanceM: 0,
      durationSec: 0,
      segments: [{ lat: points[0].lat, lon: points[0].lon }],
      trafficFetched: false,
      routeHash: null,
      topologyHash: null,
    };
  }

  const start = points[0];
  const end = points[points.length - 1];

  // 1 попытка с timeout 8 сек. Retry делегирован API.
  const result = await Promise.race<RouteResult>([
    routeRequest(start.lat, start.lon, end.lat, end.lon),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("routeRequest timeout 8s")), 8000)
    ),
  ]);

  // v2.9: вычисляем метрики и routeHash после успешной маршрутизации
  try {
    const methodologyPoints: MethodologyPointLike[] = points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      speed: p.speed ?? null,
      altitude: p.altitude ?? null,
      accuracy: p.accuracy ?? null,
      bearing: p.bearing ?? null,
      timestamp: Number(p.timestamp),
    }));
    const durationSec = (Number(end.timestamp) - Number(start.timestamp)) / 1000;
    const { metrics, routeHash, topologyHash, mapMatchLogProb } = computeAllMetrics(
      methodologyPoints,
      result.distanceM,
      Math.max(0, durationSec),
      result.segments
    );
    result.metrics = metrics;
    result.routeHash = routeHash;
    result.topologyHash = topologyHash;
    result.mapMatchLogProb = mapMatchLogProb;
  } catch (err) {
    // Не падаем — логируем и продолжаем без метрик
    console.warn("[processor] metrics computation failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  return result;
}
