// processor.ts — обработка одной TrafficJob (§3.3, §3.2).
//
// ИЗОЛЯЦИЯ (§9.6 anti-pattern: shared event loop): Worker не импортирует
// основной проект. Логика chain маршрутизации (2ГИС → OSRM → haversine)
// и circuit-breaker скопирована из src/lib/routing/{chain,circuit-breaker}.ts
// и адаптирована под worker-local env.

// === Types ===

export interface RouteSegment {
  lat: number;
  lon: number;
  distanceM?: number;
  durationSec?: number;
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
}

/**
 * Форма TrafficJob, получаемого от POST /api/worker/poll.
 * Соответствует prisma schema: TrafficJob + session.gpsPoints (ordered asc by timestamp).
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
// §3.2: opossum-like circuit breaker для 2ГИС/OSRM.

interface CircuitState {
  failures: number;
  openUntil: number; // ms timestamp
}

const circuits = new Map<string, CircuitState>();

function checkCircuit(provider: string): boolean {
  const s = circuits.get(provider);
  if (!s) return true;
  if (Date.now() < s.openUntil) return false;
  // half-open: разрешаем один запрос
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
    const url = `https://routing.api.2gis.ru/carrouting/6.0.0/global?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          { lat: startLat, lon: startLon },
          { lat: endLat, lon: endLon },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      recordFailure("2gis");
      return null;
    }
    const data = (await res.json()) as {
      result?: Array<{
        legs?: Array<{
          distance?: number;
          duration?: number;
          steps?: Array<{
            geometry?: { points?: Array<{ lat: number; lon: number }> };
          }>;
        }>;
      }>;
    };
    if (!data.result || !data.result.length) {
      recordFailure("2gis");
      return null;
    }
    const route = data.result[0];
    const legs = route.legs || [];
    const segments: RouteSegment[] = [];
    let distanceM = 0;
    let durationSec = 0;
    for (const leg of legs) {
      for (const step of leg.steps || []) {
        for (const p of step.geometry?.points || []) {
          segments.push({ lat: p.lat, lon: p.lon });
        }
      }
      distanceM += leg.distance || 0;
      durationSec += leg.duration || 0;
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

// === processJob — обработка одной TrafficJob ===

/**
 * Берёт первую и последнюю GPS-точку session.gpsPoints, строит маршрут
 * через chain (2ГИС → OSRM → haversine).
 *
 * Retry логика: 3 попытки с exponential backoff (1с, 2с, 4с) — НО retry
 * делегирован API (через status="failed", см. /api/worker/complete). Поэтому
 * processor делает 1 попытку с timeout 8 сек.
 *
 * Edge cases:
 *   - < 2 точек → haversine результат с distanceM=0
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
    };
  }
  if (points.length === 1) {
    return {
      provider: "haversine",
      distanceM: 0,
      durationSec: 0,
      segments: [{ lat: points[0].lat, lon: points[0].lon }],
      trafficFetched: false,
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
  return result;
}
