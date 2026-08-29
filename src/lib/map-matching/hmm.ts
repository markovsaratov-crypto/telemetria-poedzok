// src/lib/map-matching/hmm.ts — v2.9 методология §17.2 HMM (Viterbi) map matching.
//
// Заменяет nearest-point approach. Учитывает:
//   - близость точки к сегменту (эмиссионная вероятность)
//   - топологию дорожной сети (transition probability — достижимость следующего сегмента)
//   - историю предыдущих точек (Viterbi backpointer)
//
// Сложность O(N × M × K), K = среднее число достижимых следующих сегментов (обычно 2–4).
// Типичная поездка: 1000 точек × 50 сегментов × 3 = 150 000 операций ≈ 5 мс.
//
// Граничные случаи:
//   - 0 точек или 0 сегментов → пустой результат
//   - dt > 30 сек → разрыв, Viterbi сбрасывается, начинается заново
//   - nextSegmentIds не задан → разрешаем любой переход (упрощённая эвристика)

import { haversineM } from "../geo";
import { env } from "../env";

export interface GpsPointLike {
  lat: number;
  lon: number;
  timestamp: number; // мс
}

export interface SegmentLike {
  lat: number;
  lon: number;
  bearing?: number | null;
  nextSegmentIds?: number[];
}

export interface HmmMapMatchResult {
  segmentPerPoint: (number | null)[];
  /** Логарифм финальной вероятности Viterbi для каждой точки (для отладки). */
  logProbabilities: number[];
}

/**
 * Эмиссионная вероятность p(o_i | s_j) = (1/sqrt(2π σ²)) × exp(-d²/(2σ²)).
 * Логарифм для численной устойчивости: log p = -0.5 × log(2π σ²) - d²/(2σ²).
 */
function logEmission(distance: number, sigma: number): number {
  const sigma2 = 2 * sigma * sigma;
  return -0.5 * Math.log(2 * Math.PI * sigma2) - distance * distance / sigma2;
}

/**
 * Transition probability p(s_j → s_k) = (1/β) × exp(-Δ/β), где Δ = |routeDist - disp|.
 * Логарифм: log p = -log(β) - Δ/β.
 */
function logTransition(delta: number, beta: number): number {
  return -Math.log(beta) - delta / beta;
}

/**
 * Расстояние от точки до сегмента (haversine до ближайшей точки сегмента).
 * Для упрощения — сегмент считается точкой (lat, lon), а не полилинией.
 */
function distanceToSegment(point: GpsPointLike, segment: SegmentLike): number {
  return haversineM(point.lat, point.lon, segment.lat, segment.lon);
}

/**
 * §17.2 hmmMapMatch — Viterbi-декодирование последовательности GPS-точек в последовательность сегментов.
 *
 * @param points GPS-точки (отсортированы по timestamp asc)
 * @param segments Сегменты маршрута от провайдера (2ГИС / OSRM)
 * @returns segmentPerPoint — индекс сегмента для каждой точки (или null при невозможности)
 */
export function hmmMapMatch(
  points: GpsPointLike[],
  segments: SegmentLike[]
): HmmMapMatchResult {
  if (points.length === 0 || segments.length === 0) {
    return {
      segmentPerPoint: new Array(points.length).fill(null),
      logProbabilities: new Array(points.length).fill(-Infinity),
    };
  }

  const e = env();
  const sigma = e.HMM_EMISSION_SIGMA_M; // 5 м по умолчанию
  const beta = e.HMM_TRANSITION_BETA_M; // 5 м по умолчанию
  const GAP_MS = e.MOVING_TIME_GAP_SEC * 1000;

  const N = points.length;
  const M = segments.length;

  // V[i][j] = max log probability пути, заканчивающегося в точке i на сегменте j
  const V: number[][] = Array.from({ length: N }, () => new Array<number>(M).fill(-Infinity));
  // back[i][j] = индекс предыдущего сегмента для бэктрекинга
  const back: number[][] = Array.from({ length: N }, () => new Array<number>(M).fill(-1));

  // Init: первая точка — только эмиссия
  for (let j = 0; j < M; j++) {
    const d = distanceToSegment(points[0], segments[j]);
    V[0][j] = logEmission(d, sigma);
  }

  // Recursion
  for (let i = 1; i < N; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (dt > GAP_MS) {
      // разрыв > 30 сек — сброс Viterbi, начинаем заново
      for (let j = 0; j < M; j++) {
        const d = distanceToSegment(points[i], segments[j]);
        V[i][j] = logEmission(d, sigma);
        back[i][j] = -1;
      }
      continue;
    }
    const disp = haversineM(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon
    );

    for (let k = 0; k < M; k++) {
      const d = distanceToSegment(points[i], segments[k]);
      const emit = logEmission(d, sigma);

      let maxLogProb = -Infinity;
      let bestPrev = -1;
      for (let j = 0; j < M; j++) {
        if (!isFinite(V[i - 1][j])) continue;
        // Проверка достижимости: если у сегмента есть nextSegmentIds, k должен быть в нём
        const next = segments[j].nextSegmentIds;
        if (next && next.length > 0 && !next.includes(k)) continue;

        // routeDist — приближённо: расстояние между сегментами (haversine)
        const routeDist = haversineM(
          segments[j].lat, segments[j].lon,
          segments[k].lat, segments[k].lon
        );
        const transitionLogProb = logTransition(Math.abs(routeDist - disp), beta);
        const total = V[i - 1][j] + transitionLogProb;
        if (total > maxLogProb) {
          maxLogProb = total;
          bestPrev = j;
        }
      }
      V[i][k] = emit + maxLogProb;
      back[i][k] = bestPrev;
    }
  }

  // Backtrack: ищем сегмент с максимальной вероятностью в последней точке
  const segmentPerPoint: (number | null)[] = new Array(N).fill(null);
  const logProbabilities: number[] = new Array(N).fill(-Infinity);

  let bestFinal = -1;
  let maxFinal = -Infinity;
  for (let j = 0; j < M; j++) {
    if (V[N - 1][j] > maxFinal) {
      maxFinal = V[N - 1][j];
      bestFinal = j;
    }
  }

  if (bestFinal === -1) {
    // ни один сегмент не валиден — все null
    return { segmentPerPoint, logProbabilities };
  }

  segmentPerPoint[N - 1] = bestFinal;
  logProbabilities[N - 1] = maxFinal;
  for (let i = N - 1; i > 0; i--) {
    const prev = segmentPerPoint[i];
    if (prev == null) {
      // был gap-сброс — для предыдущей точки ищем заново
      continue;
    }
    segmentPerPoint[i - 1] = back[i][prev] === -1 ? null : back[i][prev];
    logProbabilities[i - 1] = V[i - 1][back[i][prev]] ?? -Infinity;
  }

  return { segmentPerPoint, logProbabilities };
}
