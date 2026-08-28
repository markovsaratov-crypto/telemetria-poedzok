// src/lib/kpi.ts — P2-13: единый источник KPI для десктопа, мобильного и API.
// Раньше три источника расходились: средняя скорость считалась как среднее по
// точкам (stats), как Distance/Duration (aggregate) и как mean-of-points
// (speed-distribution); схемы бакетов — 7 (UI) / 4 (API) / 6 (методология);
// мобильный KPI учитывал soft-deleted сессии. Канон — METHODOLOGY v2.6:
//   §4.3 AvgSpeed = Distance / Duration (м/с)
//   §5.3 SpeedDistribution — 6 бакетов по 20 км/ч, Σ percent = 100%
//   §4.4 MaxSpeed — с фильтрацией GPS-выбросов (обоснование в isUsableSpeedPoint)

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

// §4.3 AvgSpeed = Distance / Duration (м/с). durationSec <= 0 → null.
export function avgSpeedMs(
  distanceM: number | null | undefined,
  durationSec: number | null | undefined
): number | null {
  if (distanceM == null || durationSec == null || !Number.isFinite(distanceM) || durationSec <= 0) {
    return null;
  }
  return distanceM / durationSec;
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

/** MaxSpeed (§4.4) с фильтром выбросов. Нет пригодных точек → null. */
export function maxSpeedMs(points: SpeedPoint[]): number | null {
  let max: number | null = null;
  for (const p of points) {
    if (!isUsableSpeedPoint(p)) continue;
    if (max == null || (p.speed as number) > max) max = p.speed as number;
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
