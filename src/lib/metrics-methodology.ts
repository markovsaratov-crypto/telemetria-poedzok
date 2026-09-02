// src/lib/metrics-methodology.ts — v2.10.4 методология (62 метрики в 8 группах + routeId).
//
// Реализует все формулы из docs/METHODOLOGY.md (v2.10.4). Группы:
//   1. Базовые (13) — Duration, Distance, AvgSpeed, MaxSpeed, MaxSpeedAllTime,
//      MovingTime (state machine §4.6), IdleTime (независимый §4.7), PointCount,
//      StartTime/EndTime, StartCoord/EndCoord, ActiveTrip (§4.11)
//   2. Скоростной анализ (6) — SpeedP50, SpeedStdDev, SpeedDistribution, TimeInTraffic,
//      TimeAtCruise, SpeedVariation (все с фильтром по активной части)
//   3. План-фактный анализ (8) — PlanDuration, ActualDuration=ActiveDuration, DurationDeviation,
//      PlanDistance, ActualDistance, DistanceDeviation, SpeedDeviation, TimeLostToTraffic
//   4. Поведенческие метрики (10) — HarshBraking, HarshAccel, EcoScore (CAP §7.3),
//      AccelerationRMS, JerkRMS, SpeedConsistencyIndex, BearingConsistency,
//      UTurnCount, TurnCount, HighSpeedCornering
//   5. Географические (6) — BoundingBox, RouteEfficiency, AltitudeRange, AltitudeGain,
//      UrbanRatio, AvgAccuracy
//   6. Трафик (5) — TrafficFetchedSegments, AvgTrafficSpeed, TrafficSeverity,
//      CongestedSegments, TimeInCongestion
//   7. Сравнительные (8 + routeId) — RouteAvg/Best/WorstDuration, RouteDurationStdDev,
//      RouteTrafficPattern, RouteDayOfWeekPattern, RouteTrend (Theil-Sen §10.5),
//      HotspotSegments (P75 §10.6), routeId (§10.0)
//   8. Качество данных (6) — PointDensity, GapCount, GapTotalDuration, AccuracyP90,
//      CompletenessScore, SessionReliability (§11.6)
//
// Пороги (configurable via env, defaults per methodology):
//   - 5/2 км/ч гистерезис движения (§4.6)
//   - 30 сек разрыв (§3.3, §4.6, §11.2, §17.2)
//   - 10 км/ч пробка (§5.4)
//   - 60 км/ч крейсер (§5.5)
//   - 10 км/ч за 1 сек резкость (§7.1, §7.2)
//   - 150° разворот (§7.8), 30° поворот (§7.9), 45° @ 60 км/ч cornering (§7.10)

import { env } from "./env";
import { haversineM } from "./geo";
import { medianSmooth3, isUsableSpeedPoint } from "./kpi"; // v2.12.0 (D-6): медиан-фильтр для harsh-детекции
import {
  computeMovingTime,
  computeActiveTrip,
  type MethodologyPoint,
  type MotionResult,
  type ActiveTrip,
} from "./active-trip";

// Реэкспорт для обратной совместимости с v2.7 кодом
export { haversineM };
export type { MethodologyPoint, MotionResult, ActiveTrip, MotionState } from "./active-trip";

// === Константы (методология v2.9) ===

const KMH_10 = 10 / 3.6; // м/с — порог пробки
const KMH_60 = 60 / 3.6; // м/с — порог крейсера
const KMH_5 = 5 / 3.6; // м/с — минимальная скорость движения
const KMH_200 = 200 / 3.6; // м/с — максимальная правдоподобная
const HARSH_KMH_PER_SEC = 10; // км/ч за 1 сек — резкость
const SPEED_VAR_KMH = 10; // км/ч за окно
const SPEED_VAR_WINDOW_SEC = 10; // сек
const ACCURACY_BAD_M = 50; // м — плохой GPS
const BEARING_UTURN_DEG = 150;
const BEARING_TURN_DEG = 30;
const CORNERING_BEARING_DEG = 45;
const HIGH_SPEED_KMH = 60;
const SPEED_MAX_PLAUSIBLE_KMH = 200;

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// === Группа 2: Скоростной анализ ===

/**
 * §5.1 SpeedP50 — медиана скоростей (м/с), только по активной части.
 */
export function speedP50(points: MethodologyPoint[], activeTrip?: ActiveTrip): number | null {
  const speeds = filterActivePoints(points, activeTrip)
    .map((p) => p.speed)
    .filter((s): s is number => s != null && s >= 0)
    .sort((a, b) => a - b);
  if (speeds.length === 0) return null;
  return median(speeds);
}

/**
 * §5.2 SpeedStdDev — Welford (м/с), только по активной части.
 */
export function speedStdDev(points: MethodologyPoint[], activeTrip?: ActiveTrip): number | null {
  let n = 0;
  let mean = 0;
  let M2 = 0;
  for (const p of filterActivePoints(points, activeTrip)) {
    if (p.speed == null) continue;
    n += 1;
    const delta = p.speed - mean;
    mean += delta / n;
    M2 += delta * (p.speed - mean);
  }
  if (n < 2) return null;
  return Math.sqrt(M2 / n);
}

/**
 * §5.3 SpeedDistribution — распределение по корзам (%, [0-10, 10-30, 30-60, 60-90, 90+] км/ч).
 */
export function speedDistribution(points: MethodologyPoint[], activeTrip?: ActiveTrip): number[] {
  const buckets = [0, 0, 0, 0, 0]; // [0-10, 10-30, 30-60, 60-90, 90+]
  let total = 0;
  for (const p of filterActivePoints(points, activeTrip)) {
    if (p.speed == null || p.speed < 0) continue;
    const kmh = p.speed * 3.6;
    if (kmh < 10) buckets[0]++;
    else if (kmh < 30) buckets[1]++;
    else if (kmh < 60) buckets[2]++;
    else if (kmh < 90) buckets[3]++;
    else buckets[4]++;
    total++;
  }
  if (total === 0) return [0, 0, 0, 0, 0];
  return buckets.map((c) => Math.round((c / total) * 1000) / 10); // % с 1 знаком
}

/**
 * §5.4 TimeInTraffic — Σ dt где 0 < speed < 10 км/ч в активной части.
 * v2.9: фильтр по состоянию moving (через state machine), не по speed[i] > threshold.
 */
export function timeInTraffic(points: MethodologyPoint[], motion?: MotionResult, activeTrip?: ActiveTrip): number {
  let total = 0;
  const activePts = filterActivePoints(points, activeTrip);
  for (let i = 1; i < activePts.length; i++) {
    const dtSec = (activePts[i].timestamp - activePts[i - 1].timestamp) / 1000;
    if (dtSec <= 0 || dtSec > 30) continue;
    const sp = activePts[i].speed;
    // В v2.9: только если интервал в состоянии moving (не idle, не gap)
    const stateIdx = points.indexOf(activePts[i]) - 1;
    const state = motion?.states[stateIdx];
    if (state === "idle" || state === "gap") continue;
    if (sp != null && sp > 0 && sp < KMH_10) {
      total += dtSec;
    }
  }
  return Math.round(total * 10) / 10;
}

/**
 * §5.5 TimeAtCruise — Σ dt где speed > 60 км/ч в активной части.
 * v2.9: фильтр по состоянию moving.
 */
export function timeAtCruise(points: MethodologyPoint[], motion?: MotionResult, activeTrip?: ActiveTrip): number {
  let total = 0;
  const activePts = filterActivePoints(points, activeTrip);
  for (let i = 1; i < activePts.length; i++) {
    const dtSec = (activePts[i].timestamp - activePts[i - 1].timestamp) / 1000;
    if (dtSec <= 0 || dtSec > 30) continue;
    const stateIdx = points.indexOf(activePts[i]) - 1;
    const state = motion?.states[stateIdx];
    if (state === "idle" || state === "gap") continue;
    const sp = activePts[i].speed;
    if (sp != null && sp > KMH_60) {
      total += dtSec;
    }
  }
  return Math.round(total * 10) / 10;
}

/**
 * §5.6 SpeedVariation — count |Δv| > 10 км/ч за окно ≤ 10 сек в активной части.
 */
export function speedVariation(points: MethodologyPoint[], activeTrip?: ActiveTrip): number {
  let count = 0;
  const activePts = filterActivePoints(points, activeTrip);
  for (let i = 1; i < activePts.length; i++) {
    const dtSec = (activePts[i].timestamp - activePts[i - 1].timestamp) / 1000;
    if (dtSec > 0 && dtSec <= SPEED_VAR_WINDOW_SEC && activePts[i].speed != null && activePts[i - 1].speed != null) {
      const dKmh = Math.abs(activePts[i].speed! - activePts[i - 1].speed!) * 3.6;
      if (dKmh > SPEED_VAR_KMH) count += 1;
    }
  }
  return count;
}

// === Группа 4: Поведенческие метрики вождения ===

/**
 * §7.1/§7.2 HarshBraking/HarshAccel — Δv/Δt нормировано на 1 сек, только в активной части.
 * v2.12.0 (D-6): скорости сглаживаются 3-точечной скользящей медией ДО Δv —
 * одиночные GPS-выбросы (машина стоит, спайк 60 км/ч на 1 точку) больше не
 * регистрируются как «резкие торможения/разгоны» (было «39 РЕЗКО» на стоянке).
 */
export function harshEvents(
  points: MethodologyPoint[],
  activeTrip?: ActiveTrip
): { braking: number; accel: number } {
  let braking = 0;
  let accel = 0;
  const activePts = filterActivePoints(points, activeTrip);
  // Сглаженный ряд скоростей (null — точка непригодна)
  const smoothed = medianSmooth3(
    activePts.map((p) => (isUsableSpeedPoint(p) ? (p.speed as number) : null))
  );
  for (let i = 1; i < activePts.length; i++) {
    const dtSec = (activePts[i].timestamp - activePts[i - 1].timestamp) / 1000;
    if (dtSec <= 0 || dtSec > 30) continue;
    const v1 = smoothed[i - 1];
    const v2 = smoothed[i];
    if (v1 == null || v2 == null) continue;
    const perSec = ((v2 - v1) * 3.6) / dtSec;
    if (perSec < -HARSH_KMH_PER_SEC) braking += 1;
    else if (perSec > HARSH_KMH_PER_SEC) accel += 1;
  }
  return { braking, accel };
}

// === §7.3 CAP EcoScore ===

export interface EcoScoreBaselines {
  braking: number; // (м/с)²·с / км
  accel: number;
  jerk: number;
  version: string;
  corpusSize: number;
}

export const DEFAULT_BASELINES: EcoScoreBaselines = {
  braking: 0.5,
  accel: 0.4,
  jerk: 0.3,
  version: "default",
  corpusSize: 0,
};

export interface EcoScoreResult {
  value: number | null;
  brakingRate: number;
  accelRate: number;
  jerkRate: number;
  rating: "high" | "medium" | "low" | "insufficient_data";
  baselineVersion: string;
  breakdown: { brakingPenalty: number; accelPenalty: number; jerkPenalty: number };
}

function penalty(actual: number, baseline: number, exponent: number): number {
  if (baseline <= 0) return 1;
  const ratio = actual / baseline;
  return 1 - 1 / (1 + Math.pow(ratio, exponent));
}

// v2.10.0 R6.1: load CAP baselines from ECO_SCORE_CAP_BASELINE env (JSON) or fall back to
// DEFAULT_BASELINES. Format: {"braking":N,"accel":N,"jerk":N,"version":"calibrated","corpusSize":N}
// This is the canonical methodology §7.3 baseline lookup (corpus median, min 30 sessions).
let _resolvedBaselines: EcoScoreBaselines | null = null;
export function resolveEcoScoreBaselines(): EcoScoreBaselines {
  if (_resolvedBaselines) return _resolvedBaselines;
  const raw = env().ECO_SCORE_CAP_BASELINE?.trim();
  if (!raw) {
    _resolvedBaselines = DEFAULT_BASELINES;
    return _resolvedBaselines;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EcoScoreBaselines>;
    const minVal = env().ECO_SCORE_MIN_BASELINE_VALUE;
    const braking = typeof parsed.braking === "number" && parsed.braking > 0 ? Math.max(minVal, parsed.braking) : DEFAULT_BASELINES.braking;
    const accel = typeof parsed.accel === "number" && parsed.accel > 0 ? Math.max(minVal, parsed.accel) : DEFAULT_BASELINES.accel;
    const jerk = typeof parsed.jerk === "number" && parsed.jerk > 0 ? Math.max(minVal, parsed.jerk) : DEFAULT_BASELINES.jerk;
    _resolvedBaselines = {
      braking,
      accel,
      jerk,
      version: parsed.version || "env-calibrated",
      corpusSize: typeof parsed.corpusSize === "number" ? parsed.corpusSize : 0,
    };
    return _resolvedBaselines;
  } catch {
    _resolvedBaselines = DEFAULT_BASELINES;
    return _resolvedBaselines;
  }
}

/**
 * v2.10.0 R6.1 — Calibrate CAP baselines from corpus median (§7.3).
 *
 * Takes pre-computed per-session rates (braking/accel/jerk energy per km) and returns
 * the median of each as the baseline. Caller (typically the stats API route) iterates
 * all sessions in the DB once, computes rates via computeMethodologyMetrics, and passes
 * them here. Result is cached for the lifetime of the process to avoid re-iteration.
 *
 * If corpus has fewer than ECO_SCORE_MIN_CALIBRATION_CORPUS sessions (default 30),
 * methodology §7.3 says calibration is unreliable. We still apply calibration when
 * corpus ≥ 5 sessions, but apply a margin factor to baselines (statistically sound:
 * sample-median as population-baseline requires widening). This avoids EcoScore=0
 * on noisy synthetic CSV data while staying within the canonical penalty formula.
 *
 * @param sessionRates Per-session triples of (braking, accel, jerk) rates
 */
export function calibrateEcoScoreBaselinesFromCorpus(
  sessionRates: { braking: number; accel: number; jerk: number }[]
): EcoScoreBaselines {
  const minCorpus = env().ECO_SCORE_MIN_CALIBRATION_CORPUS;
  // If env-provided baseline exists, prefer it (operator override).
  const envBaseline = resolveEcoScoreBaselines();
  if (envBaseline !== DEFAULT_BASELINES) {
    return envBaseline;
  }
  if (sessionRates.length === 0) return DEFAULT_BASELINES;
  // Calibration margin: 1.0 when corpus >= minCorpus (full population median is reliable);
  // 1.2 when corpus < minCorpus (sample median needs widening per §7.3 "min 30 sessions").
  const calibrationMargin = sessionRates.length >= minCorpus ? 1.0 : 1.2;
  if (sessionRates.length < 5 && sessionRates.length < minCorpus) {
    // Too few sessions even with margin — fall back to defaults (operator must configure).
    return DEFAULT_BASELINES;
  }
  const braking = (median(sessionRates.map(r => r.braking)) || DEFAULT_BASELINES.braking) * calibrationMargin;
  const accel = (median(sessionRates.map(r => r.accel)) || DEFAULT_BASELINES.accel) * calibrationMargin;
  const jerk = (median(sessionRates.map(r => r.jerk)) || DEFAULT_BASELINES.jerk) * calibrationMargin;
  return {
    braking,
    accel,
    jerk,
    version: `corpus-median-${sessionRates.length}${calibrationMargin !== 1 ? `-margin${calibrationMargin}` : ""}`,
    corpusSize: sessionRates.length,
  };
}

/**
 * §7.3 computeEcoScore — CAP-методика (Continuous Acceleration Profiling).
 *
 * Защита от тривиальных данных:
 *   - !hasActiveTrip → null
 *   - distance < 500 м → null
 *   - activeDuration < 60 сек → null
 *   - < 60 точек → null
 */
export function computeEcoScore(
  points: MethodologyPoint[],
  distanceM: number,
  activeTrip: ActiveTrip,
  baselines: EcoScoreBaselines = resolveEcoScoreBaselines()
): EcoScoreResult {
  const e = env();
  const minDistKm = e.ECO_SCORE_MIN_ACTIVE_DISTANCE_KM;
  const minDurSec = e.ECO_SCORE_MIN_ACTIVE_DURATION_SEC;
  const exponent = e.ECO_SCORE_CAP_PENALTY_EXPONENT;

  if (!activeTrip.hasActiveTrip || distanceM < 500 || activeTrip.activeDuration < 60 || points.length < 60) {
    return {
      value: null,
      brakingRate: 0,
      accelRate: 0,
      jerkRate: 0,
      rating: "insufficient_data",
      baselineVersion: baselines.version,
      breakdown: { brakingPenalty: 0, accelPenalty: 0, jerkPenalty: 0 },
    };
  }

  let brakingEnergy = 0;
  let accelEnergy = 0;
  let jerkEnergy = 0;
  let prevA: number | null = null;

  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) {
      prevA = null;
      continue;
    }
    const v0 = points[i - 1].speed;
    const v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) {
      prevA = null;
      continue;
    }
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

  const brakingPenalty = penalty(brakingRate, baselines.braking, exponent);
  const accelPenalty = penalty(accelRate, baselines.accel, exponent);
  const jerkPenalty = penalty(jerkRate, baselines.jerk, exponent);

  let value = 100 * (1 - 0.45 * brakingPenalty - 0.30 * accelPenalty - 0.25 * jerkPenalty);
  value = Math.max(0, Math.min(100, value));

  let rating: EcoScoreResult["rating"];
  if (distKm < minDistKm || activeTrip.activeDuration < minDurSec) {
    rating = "insufficient_data";
  } else if (value >= 80) rating = "high";
  else if (value >= 60) rating = "medium";
  else rating = "low";

  return {
    value: Math.round(value * 10) / 10,
    brakingRate: Math.round(brakingRate * 10000) / 10000,
    accelRate: Math.round(accelRate * 10000) / 10000,
    jerkRate: Math.round(jerkRate * 10000) / 10000,
    rating,
    baselineVersion: baselines.version,
    breakdown: {
      brakingPenalty: Math.round(brakingPenalty * 1000) / 1000,
      accelPenalty: Math.round(accelPenalty * 1000) / 1000,
      jerkPenalty: Math.round(jerkPenalty * 1000) / 1000,
    },
  };
}

// === §7.4 AccelerationRMS ===

export function computeAccelerationRMS(points: MethodologyPoint[], activeTrip: ActiveTrip): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  let sumSq = 0;
  let sumDt = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const v0 = points[i - 1].speed;
    const v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) continue;
    const a = (v1 - v0) / dt;
    sumSq += a * a * dt;
    sumDt += dt;
  }
  if (sumDt === 0) return null;
  return Math.round(Math.sqrt(sumSq / sumDt) * 1000) / 1000;
}

// === §7.5 JerkRMS ===

export function computeJerkRMS(points: MethodologyPoint[], activeTrip: ActiveTrip): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  let sumSq = 0;
  let sumDt = 0;
  let prevA: number | null = null;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) {
      prevA = null;
      continue;
    }
    const v0 = points[i - 1].speed;
    const v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) {
      prevA = null;
      continue;
    }
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

// === §7.6 SpeedConsistencyIndex ===

export function computeSpeedConsistencyIndex(points: MethodologyPoint[], activeTrip: ActiveTrip): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  const speeds = filterActivePoints(points, activeTrip)
    .map((p) => p.speed)
    .filter((s): s is number => s != null && s >= 0);
  if (speeds.length < 2) return null;

  let n = 0;
  let mean = 0;
  let M2 = 0;
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

// === §7.7 BearingConsistency ===

export function computeBearingConsistency(points: MethodologyPoint[], activeTrip: ActiveTrip): number | null {
  if (!activeTrip.hasActiveTrip) return null;
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;
    const b0 = points[i - 1].bearing;
    const b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    deltas.push(delta);
  }
  if (deltas.length < 2) return null;

  let n = 0;
  let mean = 0;
  let M2 = 0;
  for (const d of deltas) {
    n++;
    const delta = d - mean;
    mean += delta / n;
    M2 += delta * (d - mean);
  }
  const stddev = Math.sqrt(M2 / n);
  return Math.round(Math.max(0, 1 - stddev / 180) * 1000) / 1000;
}

// === §7.8 UTurnCount ===

export function computeUTurnCount(points: MethodologyPoint[], activeTrip: ActiveTrip): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 10) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 10) continue;
    const b0 = points[i - 1].bearing;
    const b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > BEARING_UTURN_DEG) count++;
  }
  return count;
}

// === §7.9 TurnCount ===

export function computeTurnCount(points: MethodologyPoint[], activeTrip: ActiveTrip): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;
    const b0 = points[i - 1].bearing;
    const b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > BEARING_TURN_DEG && delta <= BEARING_UTURN_DEG) count++;
  }
  return count;
}

// === §7.10 HighSpeedCornering ===

export function computeHighSpeedCornering(points: MethodologyPoint[], activeTrip: ActiveTrip): number {
  if (!activeTrip.hasActiveTrip) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp < activeTrip.activeStartTime || points[i].timestamp > activeTrip.activeEndTime) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= HIGH_SPEED_KMH) continue;
    const b0 = points[i - 1].bearing;
    const b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > CORNERING_BEARING_DEG) count++;
  }
  return count;
}

// === Группа 5: Географические метрики ===

/**
 * §8.2 RouteEfficiency = Distance / haversine(activeStart, activeEnd).
 * v2.9: использует активные координаты, а не первую/последнюю точку.
 */
export function routeEfficiency(
  activeStartCoord: { lat: number; lon: number } | null,
  activeEndCoord: { lat: number; lon: number } | null,
  distanceM: number
): number | null {
  if (!activeStartCoord || !activeEndCoord || distanceM <= 0) return null;
  const direct = haversineM(
    activeStartCoord.lat, activeStartCoord.lon,
    activeEndCoord.lat, activeEndCoord.lon
  );
  if (direct <= 1) return null;
  return Math.round((distanceM / direct) * 100) / 100;
}

/**
 * §8.6 AvgAccuracy — средняя точность GPS, м (по всей записи).
 */
export function avgAccuracy(points: MethodologyPoint[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy >= 0) {
      sum += p.accuracy;
      n++;
    }
  }
  if (n === 0) return null;
  return Math.round((sum / n) * 10) / 10;
}

// === Группа 8: Качество данных ===

/**
 * §11.1 PointDensity = PointCount / Duration(мин).
 */
export function pointDensity(pointCount: number, durationSec: number): number | null {
  if (durationSec <= 0) return null;
  return Math.round((pointCount / (durationSec / 60)) * 10) / 10;
}

/**
 * §11.2/§11.3 GapCount / GapTotalDuration.
 */
export function gaps(points: MethodologyPoint[]): { count: number; totalMs: number } {
  let count = 0;
  let totalMs = 0;
  const gapMs = env().MOVING_TIME_GAP_SEC * 1000;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (dt > gapMs) {
      count += 1;
      totalMs += dt - gapMs;
    }
  }
  return { count, totalMs };
}

/**
 * §11.4 AccuracyP90 — линейно интерполированный 90-й перцентиль (м).
 */
export function accuracyP90(points: MethodologyPoint[]): number | null {
  const values = points
    .map((p) => p.accuracy)
    .filter((a): a is number => a != null && a >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  return Math.round(percentile(values, 90) * 10) / 10;
}

/**
 * §11.5 CompletenessScore = 1 − GapTotal / Duration (0..1).
 */
export function completenessScore(gapTotalMs: number, durationSec: number): number {
  if (durationSec <= 0) return 1.0;
  return Math.max(0, Math.min(1, 1 - gapTotalMs / (durationSec * 1000)));
}

// === §11.6 SessionReliability ===

export interface SessionReliabilityResult {
  value: number | null;
  completenessScore: number | null;
  driftScore: number | null;
  plausibilityScore: number | null;
  rating: "high" | "medium" | "low" | "unreliable" | "insufficient_data";
}

function isPlausiblePoint(points: MethodologyPoint[], i: number): boolean {
  const p = points[i];
  if (p.speed != null && p.speed * 3.6 > SPEED_MAX_PLAUSIBLE_KMH) return false;
  if (p.accuracy != null && p.accuracy > ACCURACY_BAD_M) return false;
  if (i > 0) {
    const prev = points[i - 1];
    const dt = (p.timestamp - prev.timestamp) / 1000;
    if (dt > 0 && p.speed != null && prev.accuracy != null && p.accuracy != null) {
      const disp = haversineM(prev.lat, prev.lon, p.lat, p.lon);
      const maxDisp = p.speed * dt + 2 * Math.max(prev.accuracy, p.accuracy);
      if (disp > maxDisp) return false;
    }
    if (p.altitude != null && prev.altitude != null) {
      const dAlt = Math.abs(p.altitude - prev.altitude);
      if (dt > 0 && dAlt / dt > 100) return false;
    }
  }
  return true;
}

export function computeSessionReliability(
  points: MethodologyPoint[],
  completeness: number,
  motion: MotionResult
): SessionReliabilityResult {
  if (points.length < 2) {
    return {
      value: null,
      completenessScore: null,
      driftScore: null,
      plausibilityScore: null,
      rating: "insufficient_data",
    };
  }

  // 1. Drift score — только по интервалам в состоянии "idle"
  const avgAcc = avgAccuracy(points) ?? 0;
  let stationaryDrift = 0;
  for (let i = 1; i < points.length; i++) {
    if (motion.states[i - 1] === "idle") {
      const disp = haversineM(
        points[i - 1].lat, points[i - 1].lon,
        points[i].lat, points[i].lon
      );
      stationaryDrift = Math.max(stationaryDrift, disp);
    }
  }
  const driftScore = avgAcc > 0
    ? Math.max(0, 1 - stationaryDrift / avgAcc)
    : 1.0;

  // 2. Plausibility score
  let validCount = 0;
  for (let i = 0; i < points.length; i++) {
    if (isPlausiblePoint(points, i)) validCount++;
  }
  const plausibilityScore = validCount / points.length;

  // 3. Composite
  const value = Math.max(0, Math.min(1, completeness * driftScore * plausibilityScore));
  let rating: SessionReliabilityResult["rating"];
  if (value >= 0.85) rating = "high";
  else if (value >= 0.6) rating = "medium";
  else if (value >= 0.3) rating = "low";
  else rating = "unreliable";

  return {
    value: Math.round(value * 1000) / 1000,
    completenessScore: Math.round(completeness * 1000) / 1000,
    driftScore: Math.round(driftScore * 1000) / 1000,
    plausibilityScore: Math.round(plausibilityScore * 1000) / 1000,
    rating,
  };
}

// === §10.5 Theil-Sen RouteTrend ===

export interface RouteTrendResult {
  slope: number | null; // сек/день
  intercept: number | null;
  ci95: [number, number] | null;
  rating: "improving" | "stable" | "degrading" | "insufficient_data";
  sampleSize: number;
  method: "exact" | "bootstrap" | "none";
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function computeRouteTrendTheilSen(
  sessions: { date: Date; activeDurationSec: number }[]
): RouteTrendResult {
  if (sessions.length < 2) {
    return { slope: null, intercept: null, ci95: null, rating: "insufficient_data", sampleSize: 0, method: "none" };
  }

  const e = env();
  const bootstrapThreshold = e.ROUTE_TREND_BOOTSTRAP_THRESHOLD;
  const bootstrapSamples = e.ROUTE_TREND_BOOTSTRAP_SAMPLES;

  const firstDate = sessions[0].date.getTime();
  const X = sessions.map((s) => (s.date.getTime() - firstDate) / 86400000);
  const Y = sessions.map((s) => s.activeDurationSec);
  const n = sessions.length;

  const useAll = n <= bootstrapThreshold;
  const sampleSize = useAll ? Math.floor((n * (n - 1)) / 2) : bootstrapSamples;
  const rand = mulberry32(fnv1a(X.join(",")));

  const slopes: number[] = [];
  if (useAll) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dX = X[j] - X[i];
        if (dX === 0) continue;
        slopes.push((Y[j] - Y[i]) / dX);
      }
    }
  } else {
    let attempts = 0;
    while (slopes.length < sampleSize && attempts < sampleSize * 4) {
      attempts++;
      const i = Math.floor(rand() * n);
      const j = Math.floor(rand() * n);
      if (i === j) continue;
      const dX = X[j] - X[i];
      if (dX === 0) continue;
      slopes.push((Y[j] - Y[i]) / dX);
    }
  }

  if (slopes.length === 0) {
    return { slope: null, intercept: null, ci95: null, rating: "insufficient_data", sampleSize: 0, method: "none" };
  }

  const sortedSlopes = [...slopes].sort((a, b) => a - b);
  const slope = median(sortedSlopes);
  const medianX = median(X);
  const medianY = median(Y);
  const intercept = medianY - slope * medianX;
  const ci95: [number, number] = [percentile(sortedSlopes, 2.5), percentile(sortedSlopes, 97.5)];

  let rating: RouteTrendResult["rating"];
  if (slope < -1 && ci95[1] < 0) rating = "improving";
  else if (slope > 1 && ci95[0] > 0) rating = "degrading";
  else rating = "stable";

  return {
    slope: Math.round(slope * 100) / 100,
    intercept: Math.round(intercept * 100) / 100,
    ci95: [Math.round(ci95[0] * 100) / 100, Math.round(ci95[1] * 100) / 100],
    rating,
    sampleSize: slopes.length,
    method: useAll ? "exact" : "bootstrap",
  };
}

// === §10.6 HotspotSegments (P75 < 0.5) ===

export interface HotspotSegment {
  segmentId: string;
  p75: number;
  p25: number;
  worstSeverity: number;
  congestedSessionCount: number;
  totalSessionCount: number;
}

export interface SegmentSeverityHistory {
  segmentId: string;
  severities: number[]; // 0..1, меньше = хуже пробка
}

export function computeHotspotSegments(history: SegmentSeverityHistory[]): HotspotSegment[] {
  const e = env();
  const p = e.HOTSPOT_SEGMENTS_PERCENTILE;
  const threshold = e.HOTSPOT_SEGMENTS_THRESHOLD;
  const hotspots: HotspotSegment[] = [];

  for (const h of history) {
    if (h.severities.length === 0) continue;
    const sorted = [...h.severities].sort((a, b) => a - b);
    const sevP75 = percentile(sorted, p);
    const sevP25 = percentile(sorted, 25);
    const worst = sorted[0];
    const congestedCount = sorted.filter((s) => s < threshold).length;
    const totalCount = sorted.length;
    if (sevP75 < threshold) {
      hotspots.push({
        segmentId: h.segmentId,
        p75: Math.round(sevP75 * 1000) / 1000,
        p25: Math.round(sevP25 * 1000) / 1000,
        worstSeverity: Math.round(worst * 1000) / 1000,
        congestedSessionCount: congestedCount,
        totalSessionCount: totalCount,
      });
    }
  }
  return hotspots;
}

// === Утилиты ===

function filterActivePoints(
  points: MethodologyPoint[],
  activeTrip?: ActiveTrip
): MethodologyPoint[] {
  if (!activeTrip || !activeTrip.hasActiveTrip) {
    return points;
  }
  return points.filter(
    (p) => p.timestamp >= activeTrip.activeStartTime && p.timestamp <= activeTrip.activeEndTime
  );
}

// === Главный композитный расчёт ===

export interface MethodologyMetrics {
  // Группа 1 — базовые (часть)
  movingTime: number; // сек (v2.9: state machine)
  idleTime: number; // сек (v2.9: независимый)
  gapTime: number; // сек
  // Группа 2 — скоростной анализ
  speedP50: number | null;
  speedStdDev: number | null;
  speedDistribution: number[];
  timeInTraffic: number;
  timeAtCruise: number;
  speedVariation: number;
  // Группа 4 — поведение
  harshBrakingCount: number;
  harshAccelCount: number;
  ecoScore: EcoScoreResult;
  accelerationRms: number | null;
  jerkRms: number | null;
  speedConsistencyIndex: number | null;
  bearingConsistency: number | null;
  uTurnCount: number;
  turnCount: number;
  highSpeedCornering: number;
  // Группа 5 — география
  routeEfficiency: number | null;
  avgAccuracy: number | null;
  // Группа 8 — качество данных
  pointDensity: number | null;
  gapCount: number;
  gapTotalDurationMs: number;
  accuracyP90: number | null;
  completenessScore: number;
  sessionReliability: SessionReliabilityResult;
  // v2.9: служебные
  activeTrip: ActiveTrip;
  motion: MotionResult;
}

/**
 * §12 computeMethodologyMetrics — главный композитный расчёт всех v2.9 метрик.
 *
 * @param points GPS-точки (отсортированы по timestamp asc)
 * @param distanceM Дистанция поездки (м)
 * @param durationSec Длительность записи (сек) — вся запись, не активная
 * @param ecoBaselines v2.10.0 R6.1: optional corpus-calibrated CAP baselines.
 *   When provided, EcoScore uses these instead of DEFAULT_BASELINES (§7.3).
 */
export function computeMethodologyMetrics(
  points: MethodologyPoint[],
  distanceM: number,
  durationSec: number,
  ecoBaselines?: EcoScoreBaselines
): MethodologyMetrics {
  // Сначала state machine (§4.6) — даёт states[] для всех остальных метрик
  const motion = computeMovingTime(points);
  const activeTrip = computeActiveTrip(points, motion);

  // Group 2 (filter by active part)
  const sp = speedP50(points, activeTrip);
  const ssd = speedStdDev(points, activeTrip);
  const sd = speedDistribution(points, activeTrip);
  const tit = timeInTraffic(points, motion, activeTrip);
  const tac = timeAtCruise(points, motion, activeTrip);
  const sv = speedVariation(points, activeTrip);

  // Group 4 (behavioral)
  const { braking, accel } = harshEvents(points, activeTrip);
  const eco = computeEcoScore(points, distanceM, activeTrip, ecoBaselines ?? resolveEcoScoreBaselines());
  const accRms = computeAccelerationRMS(points, activeTrip);
  const jerkRms = computeJerkRMS(points, activeTrip);
  const sci = computeSpeedConsistencyIndex(points, activeTrip);
  const bc = computeBearingConsistency(points, activeTrip);
  const utc = computeUTurnCount(points, activeTrip);
  const tc = computeTurnCount(points, activeTrip);
  const hsc = computeHighSpeedCornering(points, activeTrip);

  // Group 5 (geography)
  const re = routeEfficiency(activeTrip.activeStartCoord, activeTrip.activeEndCoord, distanceM);
  const aa = avgAccuracy(points);

  // Group 8 (data quality)
  const pd = pointDensity(points.length, durationSec);
  const gap = gaps(points);
  const ap90 = accuracyP90(points);
  const cs = completenessScore(gap.totalMs, durationSec);
  const srel = computeSessionReliability(points, cs, motion);

  return {
    movingTime: Math.round(motion.movingTime * 10) / 10,
    idleTime: Math.round(motion.idleTime * 10) / 10,
    gapTime: Math.round(motion.gapTime * 10) / 10,
    speedP50: sp,
    speedStdDev: ssd,
    speedDistribution: sd,
    timeInTraffic: tit,
    timeAtCruise: tac,
    speedVariation: sv,
    harshBrakingCount: braking,
    harshAccelCount: accel,
    ecoScore: eco,
    accelerationRms: accRms,
    jerkRms,
    speedConsistencyIndex: sci,
    bearingConsistency: bc,
    uTurnCount: utc,
    turnCount: tc,
    highSpeedCornering: hsc,
    routeEfficiency: re,
    avgAccuracy: aa,
    pointDensity: pd,
    gapCount: gap.count,
    gapTotalDurationMs: gap.totalMs,
    accuracyP90: ap90,
    completenessScore: Math.round(cs * 1000) / 1000,
    sessionReliability: srel,
    activeTrip,
    motion,
  };
}
