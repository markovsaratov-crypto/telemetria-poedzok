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

// v2.40.7 (N-3, «GPS-телепорт»): единый потолок правдоподобия скорости на
// ИНТЕРВАЛЕ между соседними точками. Константа §4.4/§11.6 (200 км/ч) перенесена
// сюда — в модуль нижнего уровня — как ЕДИНСТВЕННЫЙ источник: её импортируют
// kpi.ts (фильтр поля speed), active-trip.ts (sparse-move), session-stats.ts
// (интеграция дистанции), metrics-methodology (§11.6). Прод-кейс 20.09: две
// ZIP-импортированные записи несли «телепорты» (Саратов→Казахстан 890 км за
// 449 с = 1982 м/с и обратно 885 км за 616 с): гаверсинус интегрировал их в
// дистанцию → период показывал «2 435 км, средняя 387,3 км/ч при макс. 179,3» —
// средняя > максимума, физически невозможная пара.
export const MAX_PLAUSIBLE_SPEED_MS = 200 / 3.6; // ≈55,6 м/с = 200 км/ч

/**
 * v2.40.7 (N-3): является ли интервал между двумя соседними точками
 * «телепортом» — перемещение требует скорости выше физически возможной
 * (d/dt > MAX_PLAUSIBLE_SPEED_MS). dt ≤ 0 (дубликат timestamp с прыжком
 * позиции) — тоже телепорт: интервал не является временем.
 */
export function isTeleportInterval(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  dtSec: number,
  vMaxMs: number = MAX_PLAUSIBLE_SPEED_MS
): boolean {
  if (dtSec <= 0) return true;
  return haversineM(lat1, lon1, lat2, lon2) / dtSec > vMaxMs;
}

/**
 * v2.40.7 (N-3): дистанция интервала с фильтром телепортов — расстояние
 * засчитывается, только если оно физически достижимо за dt (v_impl ≤ 200 км/ч).
 * ЕДИНСТВЕННЫЙ способ интегрировать дистанцию по соседним точкам: все
 * Σ-гаверсинусы конвейера (session-stats/share/eco-corpus/normalized-view)
 * считают через эту функцию. GPS-джиттер на стоянке (метры) и разреженное
 * движение §4.6а (км с правдоподобной скоростью) проходят; телепорт 890 км
 * за 449 с — отбрасывается (в дистанцию и в moving).
 */
export function plausibleIntervalM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  dtSec: number,
  vMaxMs: number = MAX_PLAUSIBLE_SPEED_MS
): number {
  if (dtSec <= 0) return 0;
  const d = haversineM(lat1, lon1, lat2, lon2);
  return d / dtSec > vMaxMs ? 0 : d;
}
