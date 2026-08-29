// src/lib/active-trip.ts — v2.9 методология §4.6 MovingTime + §4.7 IdleTime + §4.11 ActiveTrip.
//
// State machine с гистерезисом 5/2 км/ч + cross-check по displacement + debounce 5 сек
// + разрыв (gap) > 30 сек. Контрольная сумма: MovingTime + IdleTime + GapTime = Duration.
//
// Возвращает массив состояний states[] длиной points.length − 1, который используется в
// других метриках (SpeedConsistency, BearingConsistency, UTurnCount, TurnCount,
// HighSpeedCornering, SessionReliability) и в UI (timeline «движение / стоянка / разрыв»).

import { env } from "./env";
import { haversineM } from "./geo";

export type MotionState = "idle" | "moving" | "gap";

export interface MethodologyPoint {
  lat: number;
  lon: number;
  speed: number | null; // м/с
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null; // 0..360°
  timestamp: number; // мс
}

export interface MotionResult {
  movingTime: number; // сек
  idleTime: number; // сек
  gapTime: number; // сек
  states: MotionState[]; // длина = points.length − 1
}

export interface ActiveTrip {
  hasActiveTrip: boolean;
  activeStartTime: number; // мс
  activeEndTime: number; // мс
  activeDuration: number; // сек
  activeStartCoord: { lat: number; lon: number };
  activeEndCoord: { lat: number; lon: number };
  preTripIdle: number; // сек — хвост в начале
  postTripIdle: number; // сек — хвост в конце
  activeIdleTime: number; // сек — стоянки внутри поездки (светофоры, пробки)
}

const KMH_TO_MS = 1 / 3.6;

/**
 * §4.6 computeMovingTime — state machine с гистерезисом, cross-check, smoothing, debounce.
 *
 * Шаги:
 * 1. effective_speed для каждого интервала (cross-check по displacement, защита от GPS-дрейфа).
 * 2. Медианное сглаживание по окну 3 (соседи — только не-gap интервалы).
 * 3. Гистерезисный переход (5/2 км/ч) + debounce 5 сек (переход подтверждён, только если
 *    новое состояние непрерывно длится ≥ 5 сек).
 * 4. Контрольная сумма: MovingTime + IdleTime + GapTime = Duration.
 */
export function computeMovingTime(points: MethodologyPoint[]): MotionResult {
  const e = env();
  const MOVING_START = e.MOVING_TIME_HYSTERESIS_HIGH_KMH * KMH_TO_MS; // 5 км/ч → м/с
  const MOVING_STOP = e.MOVING_TIME_HYSTERESIS_LOW_KMH * KMH_TO_MS; // 2 км/ч → м/с
  const MIN_STATE_DURATION = e.MOVING_TIME_DEBOUNCE_SEC; // 5 сек
  const GAP_THRESHOLD_SEC = e.MOVING_TIME_GAP_SEC; // 30 сек

  if (points.length < 2) {
    return { movingTime: 0, idleTime: 0, gapTime: 0, states: [] };
  }

  // Шаг 1: effective_speed для каждого интервала
  interface Interval {
    dt: number; // сек
    v: number; // effective_speed, м/с
    isGap: boolean;
  }
  const intervals: Interval[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0) {
      intervals.push({ dt: 0, v: 0, isGap: false });
      continue;
    }
    if (dt > GAP_THRESHOLD_SEC) {
      intervals.push({ dt, v: 0, isGap: true });
      continue;
    }

    const dispSpeed = haversineM(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon
    ) / dt;
    const driftThreshold = (points[i].accuracy ?? 0) / dt;

    let v: number;
    if (dispSpeed < driftThreshold) {
      // GPS-дрейф на стоянке (перемещение меньше радиуса погрешности)
      v = 0;
    } else if (points[i].speed != null && points[i].speed! >= 0) {
      // cross-check: берём минимум из GPS-скорости и displacement × 1.5
      v = Math.min(points[i].speed!, dispSpeed * 1.5);
    } else {
      v = dispSpeed;
    }
    intervals.push({ dt, v, isGap: false });
  }

  // Шаг 2: медианное сглаживание по окну 3 (соседи — ближайшие не-gap интервалы)
  const n = intervals.length;
  const smoothed: number[] = intervals.map((it) => it.v);
  const median3 = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 1
      ? s[0]
      : s.length % 2 === 1
        ? s[(s.length - 1) / 2]
        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  for (let i = 0; i < n; i++) {
    if (intervals[i].isGap) continue;
    const win: number[] = [intervals[i].v];
    // ближайший предыдущий не-gap
    for (let j = i - 1; j >= 0; j--) {
      if (!intervals[j].isGap) {
        win.push(intervals[j].v);
        break;
      }
    }
    // ближайший следующий не-gap
    for (let j = i + 1; j < n; j++) {
      if (!intervals[j].isGap) {
        win.push(intervals[j].v);
        break;
      }
    }
    smoothed[i] = median3(win);
  }

  // Шаг 3: state machine с гистерезисом + debounce
  // confirmed = текущее подтверждённое состояние (idle | moving)
  // candidate = кандидат на новое состояние (idle | moving | null = нет кандидата)
  // candidateDuration = длительность кандидата в сек (для debounce)
  const states: MotionState[] = new Array(n).fill("idle");
  let confirmedState: "idle" | "moving" = "idle";
  let candidate: "idle" | "moving" | null = null;
  let candidateDuration = 0;

  for (let i = 0; i < n; i++) {
    const it = intervals[i];
    if (it.isGap) {
      // разрыв — не меняем подтверждённое состояние, обнуляем кандидата
      states[i] = "gap";
      candidate = null;
      candidateDuration = 0;
      continue;
    }

    const v = smoothed[i];
    // определяем целевое состояние по сглаженной скорости
    const target: "idle" | "moving" =
      v >= MOVING_START ? "moving" : (v < MOVING_STOP ? "idle" : confirmedState);

    if (target === confirmedState) {
      // совпадает с подтверждённым — кандидат снимается
      candidate = null;
      candidateDuration = 0;
      states[i] = confirmedState;
    } else {
      // кандидат на переход
      if (candidate === target) {
        candidateDuration += it.dt;
      } else {
        candidate = target;
        candidateDuration = it.dt;
      }
      // подтверждаем переход только если кандидат длится ≥ MIN_STATE_DURATION
      if (candidateDuration >= MIN_STATE_DURATION) {
        confirmedState = target;
        candidate = null;
        candidateDuration = 0;
      }
      states[i] = confirmedState;
    }
  }

  // Шаг 4: суммируем по состояниям
  let movingTime = 0;
  let idleTime = 0;
  let gapTime = 0;
  for (let i = 0; i < n; i++) {
    const dt = intervals[i].dt;
    if (states[i] === "moving") movingTime += dt;
    else if (states[i] === "idle") idleTime += dt;
    else gapTime += dt;
  }

  return { movingTime, idleTime, gapTime, states };
}

/**
 * §4.11 computeActiveTrip — границы активной поездки.
 *
 * firstMovingIdx = первый индекс i где states[i] = "moving"
 * lastMovingIdx  = последний индекс i где states[i] = "moving"
 * ActiveStartTime = points[firstMovingIdx].timestamp
 * ActiveEndTime   = points[lastMovingIdx + 1].timestamp
 * preTripIdle + ActiveDuration + postTripIdle = Duration
 */
export function computeActiveTrip(points: MethodologyPoint[], motion: MotionResult): ActiveTrip {
  const firstMoving = motion.states.findIndex((s) => s === "moving");
  const lastMoving = motion.states.reduce<number>((acc, s, i) => (s === "moving" ? i : acc), -1);

  if (firstMoving === -1 || points.length === 0) {
    return {
      hasActiveTrip: false,
      activeStartTime: 0,
      activeEndTime: 0,
      activeDuration: 0,
      activeStartCoord: { lat: 0, lon: 0 },
      activeEndCoord: { lat: 0, lon: 0 },
      preTripIdle: 0,
      postTripIdle: 0,
      activeIdleTime: 0,
    };
  }

  const activeStartIdx = firstMoving;
  const activeEndIdx = lastMoving + 1; // points index = state index + 1
  const activeStartTs = points[activeStartIdx].timestamp;
  const activeEndTs = points[activeEndIdx].timestamp;
  const firstTs = points[0].timestamp;
  const lastTs = points[points.length - 1].timestamp;
  const preTripIdleSec = (activeStartTs - firstTs) / 1000;
  const postTripIdleSec = (lastTs - activeEndTs) / 1000;

  return {
    hasActiveTrip: true,
    activeStartTime: activeStartTs,
    activeEndTime: activeEndTs,
    activeDuration: (activeEndTs - activeStartTs) / 1000,
    activeStartCoord: { lat: points[activeStartIdx].lat, lon: points[activeStartIdx].lon },
    activeEndCoord: { lat: points[activeEndIdx].lat, lon: points[activeEndIdx].lon },
    preTripIdle: preTripIdleSec,
    postTripIdle: postTripIdleSec,
    activeIdleTime: Math.max(0, motion.idleTime - preTripIdleSec - postTripIdleSec),
  };
}
