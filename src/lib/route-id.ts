// src/lib/route-id.ts — v2.9 методология §10.0 routeId.
//
// routeId = sha256(snapToGrid(startCoord) + ":" + snapToGrid(endCoord) + ":" + topologyHash).slice(0, 16)
// где snapToGrid(coord, step) = { round(lat/step)*step, round(lon/step)*step }
//      topologyHash = sha256(последовательность ключевых точек).slice(0, 8)
//
// ВАЖНО: в коде называется `routeHash`, чтобы не путать с FK Session.routeId (admin Route).
// В API-ответах поле `routeHash` возвращает этот хэш (методология "routeId").
//
// Идемпотентность: одинаковые входы → одинаковый routeHash. Без Math.random().

import { createHash } from "crypto";
import { env } from "./env";

export interface LatLng {
  lat: number;
  lon: number;
}

export interface SegmentWithBearing {
  lat: number;
  lon: number;
  bearing?: number | null;
}

/**
 * Округление координаты до сетки (snap-to-grid). step=0.0005° ≈ 55 м на широте Москвы.
 */
function snapToGrid(coord: LatLng, step: number): { lat: number; lon: number } {
  return {
    lat: Math.round(coord.lat / step) * step,
    lon: Math.round(coord.lon / step) * step,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * §10.0 computeRouteHash — детерминированный 16-символьный хэш маршрута.
 *
 * Возвращает { routeHash, topologyHash } — routeHash сохраняется в Session.routeHash,
 * topologyHash в Session.topologyHash (для отладки).
 *
 * Граничные случаи:
 *   - segments пустые (haversine fallback) → topologyHash = "no_segments", routeHash всё равно считается
 *   - короткая поездка (< 200 м) без поворотов → keypoints = [start, end]
 *   - кольцевой маршрут (start ≈ end) → startGrid == endGrid, но topologyHash различает
 *   - hasActiveTrip = false → routeHash = null
 */
export function computeRouteHash(
  activeStartCoord: LatLng | null,
  activeEndCoord: LatLng | null,
  segments: SegmentWithBearing[]
): { routeHash: string | null; topologyHash: string | null } {
  if (!activeStartCoord || !activeEndCoord) {
    return { routeHash: null, topologyHash: null };
  }

  const e = env();
  const GRID_STEP = e.ROUTE_ID_SNAP_GRID_DEG; // 0.0005°

  const startGrid = snapToGrid(activeStartCoord, GRID_STEP);
  const endGrid = snapToGrid(activeEndCoord, GRID_STEP);

  // Ключевые точки: start + точки поворота (|Δbearing| > 60°) + end
  const keypoints: string[] = [
    `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}`,
  ];

  if (segments.length === 0) {
    // haversine fallback — нет геометрии маршрута
    keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);
    const topologyHash = "no_segments";
    const routeSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:${topologyHash}`;
    return {
      routeHash: sha256(routeSource).slice(0, 16),
      topologyHash,
    };
  }

  for (let i = 1; i < segments.length; i++) {
    const b0 = segments[i - 1].bearing;
    const b1 = segments[i].bearing;
    if (b0 != null && b1 != null) {
      const raw = Math.abs(b1 - b0);
      const delta = Math.min(raw, 360 - raw);
      if (delta > 60) {
        const grid = snapToGrid({ lat: segments[i].lat, lon: segments[i].lon }, GRID_STEP);
        keypoints.push(`${grid.lat.toFixed(4)},${grid.lon.toFixed(4)}`);
      }
    }
  }
  keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);

  const topologyHash = sha256(keypoints.join("|")).slice(0, 8);
  const routeSource =
    `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:` +
    `${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:` +
    topologyHash;
  return {
    routeHash: sha256(routeSource).slice(0, 16),
    topologyHash,
  };
}
