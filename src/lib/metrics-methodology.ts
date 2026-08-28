// src/lib/metrics-methodology.ts — П1-6: метрики методологии v2.6 (разделы 5, 7, 8.2, 11).
// Реализует группы, отсутствовавшие в коде: скоростной профиль (P50/StdDev),
// трафик (TimeInTraffic/TimeAtCruise/SpeedVariation), поведение (Harsh*/EcoScore),
// география (RouteEfficiency), качество данных (Gap*, Completeness, PointDensity, AccuracyP90).
// Все формулы — строго по METHODOLOGY.md; пороги: 3 км/ч движение, 10 км/ч пробка,
// 60 км/ч крейсер, 10 км/ч/с резкость, 30 с разрыв трека.

export interface MethodologyPoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  timestamp: number; // мс
}

const KMH_10 = 10 / 3.6; // м/с — порог пробки
const KMH_60 = 60 / 3.6; // м/с — порог крейсера
const HARSH_KMH_PER_SEC = 10; // км/ч за 1 сек
const SPEED_VAR_KMH = 10; // км/ч за окно
const SPEED_VAR_WINDOW_SEC = 10; // сек
const GAP_MS = 30_000; // 30 с — разрыв трека
const MAX_GAP_SEC = 300; // разрывы длиннее 300 с не считаются временем движения

// P2-14: канонический гаверсинус — src/lib/geo.ts; реэкспорт для обратной совместимости
import { haversineM } from "./geo";
export { haversineM };

// §5.1 SpeedP50 — медиана скоростей (м/с)
export function speedP50(points: MethodologyPoint[]): number | null {
  const speeds = points
    .map((p) => p.speed)
    .filter((s): s is number => s != null && s >= 0)
    .sort((a, b) => a - b);
  if (speeds.length === 0) return null;
  const mid = Math.floor(speeds.length / 2);
  return speeds.length % 2 !== 0
    ? speeds[mid]
    : (speeds[mid - 1] + speeds[mid]) / 2;
}

// §5.2 SpeedStdDev — Welford (м/с)
export function speedStdDev(points: MethodologyPoint[]): number | null {
  let n = 0;
  let mean = 0;
  let M2 = 0;
  for (const p of points) {
    if (p.speed == null) continue;
    n += 1;
    const delta = p.speed - mean;
    mean += delta / n;
    M2 += delta * (p.speed - mean);
  }
  if (n < 2) return null;
  return Math.sqrt(M2 / n);
}

// §5.4 TimeInTraffic — Σ dt где 0 < speed < 10 км/ч и dt < 300 с (секунды)
export function timeInTraffic(points: MethodologyPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dtSec = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    const sp = points[i].speed;
    if (dtSec > 0 && dtSec < MAX_GAP_SEC && sp != null && sp > 0 && sp < KMH_10) {
      total += dtSec;
    }
  }
  return Math.round(total * 10) / 10;
}

// §5.5 TimeAtCruise — Σ dt где speed > 60 км/ч (секунды)
export function timeAtCruise(points: MethodologyPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dtSec = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    const sp = points[i].speed;
    if (dtSec > 0 && dtSec < MAX_GAP_SEC && sp != null && sp > KMH_60) {
      total += dtSec;
    }
  }
  return Math.round(total * 10) / 10;
}

// §5.6 SpeedVariation — count |Δv| > 10 км/ч за окно ≤ 10 с
export function speedVariation(points: MethodologyPoint[]): number {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    const dtSec = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dtSec > 0 && dtSec <= SPEED_VAR_WINDOW_SEC && points[i].speed != null && points[i - 1].speed != null) {
      const dKmh = Math.abs(points[i].speed! - points[i - 1].speed!) * 3.6;
      if (dKmh > SPEED_VAR_KMH) count += 1;
    }
  }
  return count;
}

// §7.1/§7.2 HarshBraking/HarshAccel — Δv/Δt нормировано на 1 с
export function harshEvents(points: MethodologyPoint[]): { braking: number; accel: number } {
  let braking = 0;
  let accel = 0;
  for (let i = 1; i < points.length; i++) {
    const dtSec = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dtSec <= 0 || dtSec > MAX_GAP_SEC) continue;
    if (points[i].speed == null || points[i - 1].speed == null) continue;
    const perSec = ((points[i].speed! - points[i - 1].speed!) * 3.6) / dtSec;
    if (perSec < -HARSH_KMH_PER_SEC) braking += 1;
    else if (perSec > HARSH_KMH_PER_SEC) accel += 1;
  }
  return { braking, accel };
}

// §7.3 EcoScore = clamp(100 − (HB×3 + HA×2 + SV×0.5), 0, 100)
export function ecoScore(hb: number, ha: number, sv: number): number {
  return Math.max(0, Math.min(100, 100 - (hb * 3 + ha * 2 + sv * 0.5)));
}

// §8.2 RouteEfficiency = Distance / haversine(start, end)
export function routeEfficiency(points: MethodologyPoint[], distanceM: number): number | null {
  if (points.length < 2 || distanceM <= 0) return null;
  const a = points[0];
  const b = points[points.length - 1];
  const direct = haversineM(a.lat, a.lon, b.lat, b.lon);
  if (direct <= 1) return null; // старт≈финиш (круг) — деление бессмысленно
  return Math.round((distanceM / direct) * 100) / 100;
}

// §11.1 PointDensity = PointCount / Duration(мин)
export function pointDensity(pointCount: number, durationSec: number): number | null {
  if (durationSec <= 0) return null;
  return Math.round((pointCount / (durationSec / 60)) * 10) / 10;
}

// §11.2/§11.3 GapCount / GapTotalDuration (мс сверх 30 с)
export function gaps(points: MethodologyPoint[]): { count: number; totalMs: number } {
  let count = 0;
  let totalMs = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (dt > GAP_MS) {
      count += 1;
      totalMs += dt - GAP_MS;
    }
  }
  return { count, totalMs };
}

// §11.4 AccuracyP90 — линейно интерполированный 90-й перцентиль (м)
export function accuracyP90(points: MethodologyPoint[]): number | null {
  const values = points
    .map((p) => p.accuracy)
    .filter((a): a is number => a != null && a >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const idx = 0.9 * (values.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(values[lo] * 10) / 10;
  return Math.round((values[lo] + (values[hi] - values[lo]) * (idx - lo)) * 10) / 10;
}

// §11.5 CompletenessScore = 1 − GapTotal / Duration (0..1)
export function completenessScore(gapTotalMs: number, durationSec: number): number {
  if (durationSec <= 0) return 1.0;
  return Math.max(0, Math.min(1, 1 - gapTotalMs / (durationSec * 1000)));
}

export interface MethodologyMetrics {
  // Группа 2 — скоростной профиль
  speedP50: number | null; // м/с
  speedStdDev: number | null; // м/с
  timeInTraffic: number; // сек
  timeAtCruise: number; // сек
  speedVariation: number; // шт
  // Группа 4 — поведение
  harshBrakingCount: number; // шт
  harshAccelCount: number; // шт
  ecoScore: number; // 0..100
  // Группа 5 — география
  routeEfficiency: number | null; // x
  // Группа 8 — качество данных
  pointDensity: number | null; // точек/мин
  gapCount: number; // шт
  gapTotalDurationMs: number; // мс
  accuracyP90: number | null; // м
  completenessScore: number; // 0..1
}

export function computeMethodologyMetrics(
  points: MethodologyPoint[],
  distanceM: number,
  durationSec: number
): MethodologyMetrics {
  const sv = speedVariation(points);
  const { braking, accel } = harshEvents(points);
  const gap = gaps(points);
  return {
    speedP50: speedP50(points),
    speedStdDev: speedStdDev(points),
    timeInTraffic: timeInTraffic(points),
    timeAtCruise: timeAtCruise(points),
    speedVariation: sv,
    harshBrakingCount: braking,
    harshAccelCount: accel,
    ecoScore: ecoScore(braking, accel, sv),
    routeEfficiency: routeEfficiency(points, distanceM),
    pointDensity: pointDensity(points.length, durationSec),
    gapCount: gap.count,
    gapTotalDurationMs: gap.totalMs,
    accuracyP90: accuracyP90(points),
    completenessScore: completenessScore(gap.totalMs, durationSec),
  };
}
