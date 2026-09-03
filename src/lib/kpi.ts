// src/lib/kpi.ts — P2-13: единый источник KPI для десктопа, мобильного и API.
// Раньше три источника расходились: средняя скорость считалась как среднее по
// точкам (stats), как Distance/Duration (aggregate) и как mean-of-points
// (speed-distribution); схемы бакетов — 7 (UI) / 4 (API) / 6 (методология);
// мобильный KPI учитывал soft-deleted сессии. Канон — METHODOLOGY v2.7:
//   §4.3 AvgSpeed = Distance / Duration (м/с)
//   §5.3 SpeedDistribution — 6 бакетов по 20 км/ч, Σ percent = 100%
//   §4.4 MaxSpeed — с фильтрацией GPS-выбросов (обоснование в isUsableSpeedPoint)

import { haversineM } from "@/lib/geo"; // AUDIT B-4: геометрическая проверка скоростей
export interface SpeedBucketDef {
  label: string;
  minKmh: number;
  maxKmh: number | null; // null = верхняя граница отсутствует (последний бакет)
}

// §5.3: 0-20 (стоянка, пробка), 20-40 (городской поток), 40-60 (магистраль),
// 60-80 (пригород), 80-100 (шоссе), 100+ (трасса). Равный шаг 20 км/ч.
export const SPEED_BUCKETS: readonly SpeedBucketDef[] = [
  { label: "0-20", minKmh: 0, maxKmh: 20 },
  { label: "20-40", minKmh: 20, maxKmh: 40 },
  { label: "40-60", minKmh: 40, maxKmh: 60 },
  { label: "60-80", minKmh: 60, maxKmh: 80 },
  { label: "80-100", minKmh: 80, maxKmh: 100 },
  { label: "100+", minKmh: 100, maxKmh: null },
];

/** Индекс бакета §5.3 для скорости в км/ч (последний бакет — «100+»). */
export function assignSpeedBucketIndex(kmh: number): number {
  for (let i = 0; i < SPEED_BUCKETS.length - 1; i++) {
    const b = SPEED_BUCKETS[i];
    if (kmh >= b.minKmh && kmh < (b.maxKmh as number)) return i;
  }
  return SPEED_BUCKETS.length - 1;
}

// §4.3 AvgSpeed = Distance / ActiveDuration (м/с). v2.9: формула использует ActiveDuration
// (раздел 4.11) вместо Duration — отсекает «хвосты» (стоянки в начале/конце записи).
// Если activeDurationSec не передан (null/undefined) — fallback на durationSec для обратной
// совместимости с v2.7 кодом, не имеющим ActiveTrip.
export function avgSpeedMs(
  distanceM: number | null | undefined,
  durationSec: number | null | undefined,
  activeDurationSec?: number | null
): number | null {
  if (distanceM == null || !Number.isFinite(distanceM)) return null;
  // v2.9: предпочтение ActiveDuration; fallback на Duration для legacy callers
  const dur = activeDurationSec != null && Number.isFinite(activeDurationSec) && activeDurationSec > 0
    ? activeDurationSec
    : durationSec;
  if (dur == null || !Number.isFinite(dur) || dur <= 0) return null;
  return distanceM / dur;
}

// §4.4 + фильтр GPS-выбросов. Методология берёт max(speed) при speed >= 0,
// однако GPS-джиттер порождает физически невозможные скорости (сотни м/с),
// из-за чего MaxSpeed на экране достигала ~900 км/ч. Отбрасываем:
//   - speed > 70 м/с (252 км/ч) — предел для дорожного транспорта;
//   - точки с accuracy > 100 м — координата/скорость недостоверны.
export const MAX_PLAUSIBLE_SPEED_MS = 70; // 252 км/ч
export const MAX_TRUSTED_ACCURACY_M = 100;

export interface SpeedPoint {
  speed?: number | null;
  accuracy?: number | null;
}

export function isUsableSpeedPoint(p: SpeedPoint): boolean {
  if (p.speed == null || !Number.isFinite(p.speed) || p.speed < 0) return false;
  if (p.speed > MAX_PLAUSIBLE_SPEED_MS) return false;
  if (p.accuracy != null && p.accuracy > MAX_TRUSTED_ACCURACY_M) return false;
  return true;
}

// v2.12.0 (D-6): 3-точечная скользящая медиана — гасит одиночные GPS-выбросы скорости.
// Реальный пик (машина шла 40 → 60 → 58) остаётся пиком (медиана = 58), а
// одиночный спайк на месте стоянки (0 → 60,8 → 0) превращается в 0.
// Граничные точки (нет соседа с одной стороны) проходят как есть.
export function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

/** v2.16.0: честная медиана числового ряда (чётная длина — среднее двух центральных).
 *  Единственная реализация для kpi/metrics-methodology — раньше чётные ряды
 *  в normalizeSessionSpeeds брали верхний центральный элемент (смещение вверх). */
export function medianOf(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

// v2.16.0: порог «резкости» §7.1/§7.2 = 10 км/ч/с (2,78 м/с²) — ЕДИНСТВЕННОЕ
// определение для events/track-роутов и конвейера методологии (раньше 3 копии
// константы 10/3.6 жили в трёх файлах и могли разъехаться).
export const HARSH_THRESHOLD_MS2 = 10 / 3.6;

export function medianSmooth3(speeds: Array<number | null>): Array<number | null> {
  const out: Array<number | null> = speeds.slice();
  for (let i = 0; i < speeds.length; i++) {
    const v = speeds[i];
    if (v == null) continue;
    const a = speeds[i - 1] ?? v;
    const b = speeds[i + 1] ?? v;
    out[i] = median3(a, v, b);
  }
  return out;
}

/** MaxSpeed (§4.4) с фильтром выбросов. Нет пригодных точек → null.
 *  v2.12.0 (D-6): поверх статических границ (правдоподобие/точность) — 3-точечная
 *  медиана: одиночный GPS-спайк больше не становится «максимальной скоростью». */
export function maxSpeedMs(points: SpeedPoint[]): number | null {
  const smoothed = medianSmooth3(
    points.map((p) => (isUsableSpeedPoint(p) ? (p.speed as number) : null))
  );
  let max: number | null = null;
  for (const v of smoothed) {
    if (v == null) continue;
    if (max == null || v > max) max = v;
  }
  return max;
}

/**
 * Средняя скорость ПО ТОЧКАМ (mean of point speeds). Это НЕ AvgSpeed §4.3:
 * методология определяет среднюю скорость поездки как Distance/Duration.
 * Используется для SpeedMean-профиля, а не для KPI-тайла.
 */
export function meanPointSpeedMs(points: SpeedPoint[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (!isUsableSpeedPoint(p)) continue;
    sum += p.speed as number;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

export interface SpeedBucketCount extends SpeedBucketDef {
  count: number;
  percent: number;
}

export interface SpeedDistributionResult {
  buckets: SpeedBucketCount[];
  total: number; // точки, вошедшие в распределение (включая стоянки — §5.3)
}

/**
 * SpeedDistribution (§5.3) — 6 бакетов, включая стоянки в «0-20»
 * («0 ≤ speed_kmh < 20» — стоянка/пробка по обоснованию методологии).
 * percent округляется до 0,1; дрейф округления компенсируется в бакете
 * с максимальным count, чтобы Σ percent = 100 (контроль суммы §5.3).
 */
export function computeSpeedDistribution(points: SpeedPoint[]): SpeedDistributionResult {
  const counts = SPEED_BUCKETS.map(() => 0);
  let total = 0;
  for (const p of points) {
    if (!isUsableSpeedPoint(p)) continue;
    counts[assignSpeedBucketIndex((p.speed as number) * 3.6)] += 1;
    total += 1;
  }

  const buckets: SpeedBucketCount[] = SPEED_BUCKETS.map((b, i) => ({
    ...b,
    count: counts[i],
    percent: total > 0 ? Math.round((counts[i] / total) * 1000) / 10 : 0,
  }));

  if (total > 0) {
    const sum = buckets.reduce((acc, b) => acc + b.percent, 0);
    const drift = Math.round((100 - sum) * 10) / 10;
    if (drift !== 0) {
      let maxIdx = 0;
      for (let i = 1; i < buckets.length; i++) if (buckets[i].count > buckets[maxIdx].count) maxIdx = i;
      buckets[maxIdx].percent = Math.round((buckets[maxIdx].percent + drift) * 10) / 10;
    }
  }

  return { buckets, total };
}

// AUDIT B-4: нормализация сессионных скоростей.
// Проблема: у ряда iPhone-сессий поле speed систематически НЕ соответствует геометрии
// (например: 79,9 км за 92 мин при max(speed)=5,6 м/с → «Макс. 20 км/ч» при средней 52).
// Решение: если записанные скорости глобально не согласуются с перемещением
// (медиана пригодных скоростей < 40% от средней геометрической, при заметном движении),
// скорости пересчитываются по геометрии (гаверсинус / dt) с защитами:
//   - дрейф: перемещение < погрешности GPS → v = 0;
//   - правдоподобность: v ≤ MAX_PLAUSIBLE_SPEED_MS;
//   - интервалы только 0.5–30 сек (дальше — gap, скорость не тянется).
// Хорошим данным (записанная скорость согласована) функция ничего не меняет.
export interface NormalizablePoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  bearing: number | null;
  accuracy: number | null;
  timestamp: number;
}

export function normalizeSessionSpeeds<P extends NormalizablePoint>(points: P[]): P[] {
  if (points.length < 2) return points;

  // Средняя геометрическая скорость поездки (по гаверсинусу).
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  const durSec = Math.max(0, (points[points.length - 1].timestamp - points[0].timestamp) / 1000);
  if (durSec <= 0) return points;
  const geoAvg = dist / durSec;

  // Пригодные записанные скорости.
  const usable: number[] = [];
  for (const p of points) {
    if (isUsableSpeedPoint(p)) usable.push(p.speed as number);
  }
  if (usable.length === 0) return points; // нет годных записанных — метрики и так геометрические
  usable.sort((a, b) => a - b);
  const median = medianOf(usable); // v2.16.0: честная медиана (чётные ряды — среднее центров)

  // Критерий «глобально не согласованы»: заметное движение есть (geoAvg > 2 м/с ≈ 7 км/ч),
  // а медиана записанных скоростей резко ниже геометрии.
  const inconsistent = geoAvg > 2 && median < 0.4 * geoAvg;
  if (!inconsistent) return points;

  // Пересчёт по геометрии с защитами.
  const out = points.map((p) => ({ ...p }));
  let prevSpeed = 0;
  for (let i = 1; i < out.length; i++) {
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    const disp = haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    let v: number | null = null;
    if (dt >= 0.5 && dt <= 30) {
      v = disp / dt;
      if (v > MAX_PLAUSIBLE_SPEED_MS) v = null;
      // GPS-дрейф: перемещение меньше погрешности — стоим на месте.
      const acc = Math.max(points[i].accuracy ?? 0, points[i - 1].accuracy ?? 0);
      if (disp < acc) v = 0;
    }
    if (v != null) {
      out[i].speed = Math.round(v * 100) / 100;
      prevSpeed = out[i].speed as number;
    } else {
      out[i].speed = out[i].speed ?? prevSpeed;
    }
  }
  out[0].speed = out[1]?.speed ?? out[0].speed;
  return out;
}
