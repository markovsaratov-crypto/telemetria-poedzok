// src/lib/routing/chain.ts — 3-уровневая цепочка маршрутизации (§3.2):
// 1) 2ГИС carrouting 6.0.0 (primary, traffic-aware)
// 2) OSRM demo server (fallback, без пробок)
// 3) Гаверсинус 40 км/ч (last resort)
import { env } from "../env";
import { logger } from "../logger";
import { checkCircuit, recordFailure, recordSuccess } from "./circuit-breaker";

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
  polyline: [number, number][];
  segments: RouteSegment[];
  cached?: boolean;
  trafficFetched?: boolean;
  trafficUtc?: string;
}

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

async function route2Gis(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult | null> {
  const key = env().TWO_GIS_API_KEY;
  if (!key) return null;
  if (!checkCircuit("2gis")) {
    logger.warn("2ГИС circuit open, skip", { provider: "2gis" });
    return null;
  }
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
      logger.warn("2ГИС non-ok", { status: res.status });
      return null;
    }
    const data = await res.json();
    if (!data.result || !data.result.length) {
      recordFailure("2gis");
      return null;
    }
    const route = data.result[0];
    const legs = route.legs || [];
    const segments: RouteSegment[] = [];
    let distanceM = 0;
    let durationSec = 0;
    let polyline: [number, number][] = [];
    for (const leg of legs) {
      for (const step of leg.steps || []) {
        for (const p of step.geometry?.points || []) {
          polyline.push([p.lat, p.lon]);
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
      polyline,
      segments,
      trafficFetched: true,
      trafficUtc: new Date().toISOString(),
    };
  } catch (err) {
    recordFailure("2gis");
    logger.warn("2ГИС error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function routeOsrm(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult | null> {
  if (!checkCircuit("osrm")) return null;
  try {
    const base = env().OSRM_BASE_URL;
    const url = `${base}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      recordFailure("osrm");
      return null;
    }
    const data = await res.json();
    if (!data.routes || !data.routes.length) {
      recordFailure("osrm");
      return null;
    }
    const r = data.routes[0];
    const coords: [number, number][] = (r.geometry?.coordinates || []).map(
      (c: [number, number]) => [c[1], c[0]]
    );
    const segments: RouteSegment[] = coords.map(([lat, lon]) => ({ lat, lon }));
    recordSuccess("osrm");
    return {
      provider: "osrm",
      distanceM: r.distance || 0,
      durationSec: r.duration || 0,
      polyline: coords,
      segments,
      trafficFetched: false,
    };
  } catch (err) {
    recordFailure("osrm");
    logger.warn("OSRM error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function routeHaversine(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): RouteResult {
  const distanceM = haversine(startLat, startLon, endLat, endLon);
  const durationSec = Math.round((distanceM / 1000) / 40 * 3600);
  const polyline: [number, number][] = [
    [startLat, startLon],
    [endLat, endLon],
  ];
  return {
    provider: "haversine",
    distanceM,
    durationSec,
    polyline,
    segments: [{ lat: startLat, lon: startLon }, { lat: endLat, lon: endLon }],
    trafficFetched: false,
  };
}

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
