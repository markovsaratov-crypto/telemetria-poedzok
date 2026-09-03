// src/lib/geo.ts — P2-14: единственная каноническая реализация гаверсинуса.
// Раньше 6 идентичных копий жили в format.ts, chain.ts, metrics-methodology.ts,
// stats и /shared — единое место исключает расхождения формул.
// R = 6371000 м — строго по METHODOLOGY.md §4.2.

const EARTH_R_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Расстояние между двумя точками (гаверсинус, метры).
 * Единственный источник формулы — METHODOLOGY §4.2 (R = 6 371 000 м).
 */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  // v2.16.0: clamp от флот-округления на антиподальных точках (a чуть > 1 давал NaN)
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Суммарная длина трека по последовательным точкам (метры). */
export function trackDistanceM(points: Array<{ lat: number; lon: number }>): number {
  if (points.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return d;
}
