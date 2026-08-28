// src/lib/routing/chain.ts — 3-уровневая цепочка маршрутизации (§3.2):
// 1) 2ГИС carrouting 6.0.0 (primary, traffic-aware)
// 2) OSRM demo server (fallback, без пробок)
// 3) Гаверсинус 40 км/ч (last resort)
import { env } from "../env";
import { getSettingSync } from "../settings";
import { logger } from "../logger";
import { checkCircuit, recordFailure, recordSuccess } from "./circuit-breaker";
// P2-14: канонический гаверсинус — src/lib/geo.ts (была локальная копия)
import { haversineM as haversine } from "@/lib/geo";
export { haversine };

export interface RouteSegment {
  lat: number;
  lon: number;
  distanceM?: number; // P1-7: длина сегмента (м) — от провайдера
  durationSec?: number; // P1-7: время сегмента (с) — от провайдера
  planSpeedKmh?: number; // P1-7: плановая скорость сегмента (км/ч)
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
  // P1-7: план-фактные поля результата (§6.1/§6.4 методологии)
  planDistanceM?: number | null; // план без трафика (OSRM/haversine); для 2ГИС null
  planDurationSec?: number | null;
  trafficDistanceM?: number | null; // с учётом пробок (2ГИС)
  trafficDurationSec?: number | null;
}

async function route2Gis(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult | null> {
  const key = getSettingSync("TWO_GIS_API_KEY");
  if (!key) return null;
  if (!checkCircuit("2gis")) {
    logger.warn("2ГИС circuit open, skip", { provider: "2gis" });
    return null;
  }
  try {
    // 2ГИС API: catalog.api.2gis.ru works globally (routing.api.2gis.ru is dead).
    // Optional Cloudflare Worker proxy for Russian edge routing.
    const proxyUrl = getSettingSync("TWO_GIS_PROXY_URL") || process.env.TWO_GIS_PROXY_URL || "";
    const baseUrl = proxyUrl || "https://catalog.api.2gis.ru";
    const apiUrl = `${baseUrl}/carrouting/6.0.0/global?key=${key}`;
    const res = await fetch(apiUrl, {
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
      logger.warn("2ГИС non-ok", { status: res.status });
      return null;
    }
    const data = await res.json();
    if (!data.result || !data.result.length) {
      recordFailure("2gis");
      return null;
    }
    const route = data.result[0];
    // 2ГИС returns total_distance and total_duration directly (not in legs[])
    const distanceM = route.total_distance || 0;
    const durationSec = route.total_duration || 0;
    const hasTraffic = (route.algorithm || "").includes("traffic");

    // Extract polyline from maneuvers
    // P1-7: per-segment дистанция/время — манёвр содержит outcoming_path {distance, duration, geometry[]};
    // значения пути распределяем по его координатам пропорционально.
    const segments: RouteSegment[] = [];
    const polyline: [number, number][] = [];
    const maneuvers = route.maneuvers || [];
    for (const m of maneuvers) {
      const paths = m.outcoming_path || [];
      for (const path of paths) {
        const pathDistance = Number(path.distance) || 0;
        const pathDuration = Number(path.duration) || 0;
        const geometry = path.geometry || [];
        const pathCoords: [number, number][] = [];
        for (const g of geometry) {
          if (g.selection) {
            // Parse LINESTRING(lon1 lat1, lon2 lat2, ...)
            const coords = g.selection.replace("LINESTRING(", "").replace(")", "").split(",");
            for (const c of coords) {
              const [lon, lat] = c.trim().split(" ").map(Number);
              if (!isNaN(lat) && !isNaN(lon)) {
                pathCoords.push([lat, lon]);
              }
            }
          }
        }
        const n = pathCoords.length;
        if (n === 0) continue;
        const perDist = n > 0 ? pathDistance / n : 0;
        const perDur = n > 0 ? pathDuration / n : 0;
        for (const [lat, lon] of pathCoords) {
          polyline.push([lat, lon]);
          segments.push({
            lat,
            lon,
            distanceM: Math.round(perDist * 100) / 100,
            durationSec: Math.round(perDur * 100) / 100,
            planSpeedKmh: perDur > 0 ? Math.round((perDist / perDur) * 3.6 * 10) / 10 : undefined,
            trafficSpeedKmh: perDur > 0 ? Math.round((perDist / perDur) * 3.6 * 10) / 10 : undefined,
            trafficSource: "2gis",
            trafficUtc: undefined,
          });
        }
      }
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
      // 2ГИС даёт время с пробками; свободный поток отдельно не отдаёт → план = null
      planDistanceM: null,
      planDurationSec: null,
      trafficDistanceM: distanceM,
      trafficDurationSec: durationSec,
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
    const base = getSettingSync("OSRM_BASE_URL") || env().OSRM_BASE_URL;
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
    // P1-7: OSRM — свободный поток (без пробок) → сегменты без трафика, план = результат
    const segments: RouteSegment[] = coords.map(([lat, lon]) => ({ lat, lon }));
    recordSuccess("osrm");
    return {
      provider: "osrm",
      distanceM: r.distance || 0,
      durationSec: r.duration || 0,
      polyline: coords,
      segments,
      trafficFetched: false,
      planDistanceM: r.distance || 0,
      planDurationSec: r.duration || 0,
      trafficDistanceM: null,
      trafficDurationSec: null,
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
    planDistanceM: distanceM,
    planDurationSec: durationSec,
    trafficDistanceM: null,
    trafficDurationSec: null,
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
