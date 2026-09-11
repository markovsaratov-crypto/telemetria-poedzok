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

export interface ActiveTripLeg {
  startTime: number; // мс — timestamp левой точки первого moving-интервала leg
  endTime: number; // мс — timestamp правой точки последнего moving-интервала leg
  durationSec: number;
  startCoord: { lat: number; lon: number };
  endCoord: { lat: number; lon: number };
}

export interface ActiveTrip {
  hasActiveTrip: boolean;
  activeStartTime: number; // мс
  activeEndTime: number; // мс
  // v2.25.0 (П.3): СУММА длительностей legs — настоящее «в поездке». Запись
  // «утром доехал → 8,5 ч на парковке → вечером уехал» теперь даёт ~50 мин,
  // а не 9 ч 21 мин (старая семантика — см. spanDuration).
  activeDuration: number; // сек
  // v2.25.0 (П.3): СТАРАЯ семантика activeDuration — span от первого до
  // последнего движения ВКЛЮЧАЯ внутренние долгие стоянки. Контрольная сумма
  // preTripIdle + spanDuration + postTripIdle = Duration остаётся верной.
  spanDuration: number; // сек
  // v2.25.0 (П.3): запись разбита длинными стоянками на несколько поездок
  legCount: number;
  legs: ActiveTripLeg[];
  longestInternalStopSec: number; // самая длинная внутренняя стоянка-разделитель
  internalStopTime: number; // сек — суммарное время долгих стоянок между legs
  activeStartCoord: { lat: number; lon: number };
  activeEndCoord: { lat: number; lon: number };
  preTripIdle: number; // сек — хвост в начале
  postTripIdle: number; // сек — хвост в конце
  activeIdleTime: number; // сек — стоянки ВНУТРИ legs (светофоры, пробки)
}

const EMPTY_ACTIVE_TRIP: ActiveTrip = {
  hasActiveTrip: false,
  activeStartTime: 0,
  activeEndTime: 0,
  activeDuration: 0,
  spanDuration: 0,
  legCount: 0,
  legs: [],
  longestInternalStopSec: 0,
  internalStopTime: 0,
  activeStartCoord: { lat: 0, lon: 0 },
  activeEndCoord: { lat: 0, lon: 0 },
  preTripIdle: 0,
  postTripIdle: 0,
  activeIdleTime: 0,
};

/**
 * v2.25.0 (П.3/П.4): точка с timestamp ts принадлежит активной части записи?
 * Для мульти-leg записей — membership в объединении leg-окон (долгие парковки
 * между legs исключены). Для legacy-объектов без legs — fallback на span.
 * Единый предикат для EcoScore/событий/метрик: энергия и резкие события больше
 * не интегрируются по 8-часовому джиттеру на парковке.
 */
export function inActiveLegs(activeTrip: ActiveTrip, ts: number): boolean {
  if (!activeTrip.hasActiveTrip) return false;
  if (activeTrip.legs && activeTrip.legs.length > 0) {
    for (const l of activeTrip.legs) {
      if (ts >= l.startTime && ts <= l.endTime) return true;
    }
    return false;
  }
  return ts >= activeTrip.activeStartTime && ts <= activeTrip.activeEndTime;
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
 * §4.11 computeActiveTrip — границы активной поездки + разбиение на legs.
 *
 * firstMovingIdx = первый индекс i где states[i] = "moving"
 * lastMovingIdx  = последний индекс i где states[i] = "moving"
 * ActiveStartTime = points[firstMovingIdx].timestamp
 * ActiveEndTime   = points[lastMovingIdx + 1].timestamp
 * preTripIdle + spanDuration + postTripIdle = Duration
 *
 * v2.25.0 (П.3): ВНУТРЕННИЕ стоянки (последовательные idle/gap-интервалы суммарно
 * ≥ ACTIVE_TRIP_STOP_SPLIT_SEC, по умолчанию 15 мин) разбивают активную поездку на
 * legs: рабочая запись «утром доехал → 8,5 ч на парковке → вечером уехал» — это
 * 2 поездки. activeDuration = Σ legs (настоящее «в поездке»), spanDuration —
 * прежняя semantics «первое→последнее движение». Светофоры/пробки (< порога)
 * остаются внутри legs — активная поездка по §4.11 их по-прежнему включает.
 */
export function computeActiveTrip(points: MethodologyPoint[], motion: MotionResult): ActiveTrip {
  const firstMoving = motion.states.findIndex((s) => s === "moving");
  const lastMoving = motion.states.reduce<number>((acc, s, i) => (s === "moving" ? i : acc), -1);

  if (firstMoving === -1 || points.length === 0) {
    return { ...EMPTY_ACTIVE_TRIP, legs: [] };
  }

  const activeStartIdx = firstMoving;
  const activeEndIdx = lastMoving + 1; // points index = state index + 1
  const activeStartTs = points[activeStartIdx].timestamp;
  const activeEndTs = points[activeEndIdx].timestamp;
  const firstTs = points[0].timestamp;
  const lastTs = points[points.length - 1].timestamp;
  const preTripIdleSec = (activeStartTs - firstTs) / 1000;
  const postTripIdleSec = (lastTs - activeEndTs) / 1000;
  const spanDurationSec = (activeEndTs - activeStartTs) / 1000;

  // v2.25.0 (П.3): проход по состояниям активного окна — ищем длинные стоянки.
  // states[i] описывает интервал points[i] → points[i+1]; «стоянка-run» — серия
  // подряд идущих idle/gap-интервалов; run ≥ порога закрывает текущий leg.
  // Для каждого leg-кандидата копим его внутренний idle (для activeIdleTime).
  const splitSec = Math.max(60, env().ACTIVE_TRIP_STOP_SPLIT_SEC);
  const minLegSec = Math.max(5, env().ACTIVE_TRIP_MIN_LEG_SEC);
  const rawLegs: Array<{ startTime: number; endTime: number; idleSec: number }> = [];
  let curLegStartState: number | null = null; // state idx первого moving текущего leg
  let runStartState: number | null = null; // state idx начала текущей стоянки-run
  let runSec = 0;
  let legIdleSec = 0; // idle внутри текущего leg-кандидата

  const closeLeg = (legStartState: number, legEndMoving: number, idleSec: number) => {
    const startTs = points[legStartState].timestamp;
    const endTs = points[legEndMoving + 1].timestamp;
    if (endTs <= startTs) return; // вырожденный leg — пропускаем
    rawLegs.push({ startTime: startTs, endTime: endTs, idleSec });
  };

  for (let i = firstMoving; i <= lastMoving; i++) {
    const st = motion.states[i];
    const dt = Math.max(0, (points[i + 1].timestamp - points[i].timestamp) / 1000);
    if (st === "moving") {
      if (curLegStartState == null) curLegStartState = i;
      runStartState = null;
      runSec = 0;
      continue;
    }
    if (st === "idle" && curLegStartState != null) legIdleSec += dt;
    // idle или gap — копим стоянку-run
    if (runStartState == null) {
      runStartState = i;
      runSec = 0;
    }
    runSec += dt;
    if (runSec >= splitSec && curLegStartState != null) {
      // Долгая стоянка: закрываем текущий leg на последнем moving до run
      closeLeg(curLegStartState, runStartState - 1, legIdleSec);
      curLegStartState = null;
      legIdleSec = 0;
    }
  }
  if (curLegStartState != null) {
    closeLeg(curLegStartState, lastMoving, legIdleSec);
  }

  // v2.25.0 (П.3): джиттер-микро-legs (GPS-дрейф дал «движение» на парковке
  // 12–30 сек) — не поездки: отбрасываем в паузы. Если после фильтра ничего не
  // осталось — оставляем самый длинный кандидат (движение в записи было).
  const keptCandidates = rawLegs.filter((l) => (l.endTime - l.startTime) / 1000 >= minLegSec);
  const finalRaw =
    keptCandidates.length > 0
      ? keptCandidates
      : rawLegs.length > 0
        ? [rawLegs.reduce((a, b) => (b.endTime - b.startTime > a.endTime - a.startTime ? b : a))]
        : [{ startTime: activeStartTs, endTime: activeEndTs, idleSec: 0 }]; // degenerate: span одним leg

  const legs: ActiveTripLeg[] = finalRaw.map((l) => ({
    startTime: l.startTime,
    endTime: l.endTime,
    durationSec: (l.endTime - l.startTime) / 1000,
    startCoord: findCoordAtOrAfter(points, l.startTime),
    endCoord: findCoordAtOrBefore(points, l.endTime),
  }));

  const legCount = legs.length;
  const legsDurationSec = legs.reduce((acc, l) => acc + l.durationSec, 0);
  const activeDurationSec = legsDurationSec;
  // Паузы = всё время span, не вошедшее в legs (стоянки + отброшенные микро-legs)
  const internalStopSec = Math.max(0, spanDurationSec - legsDurationSec);
  // Самая длинная пауза — между последовательными legs (включая съеденные микро-legs)
  let longestStopSec = 0;
  for (let i = 1; i < legs.length; i++) {
    longestStopSec = Math.max(longestStopSec, (legs[i].startTime - legs[i - 1].endTime) / 1000);
  }
  const keptIdleSec = finalRaw.reduce((acc, l) => acc + l.idleSec, 0);

  return {
    hasActiveTrip: true,
    activeStartTime: activeStartTs,
    activeEndTime: activeEndTs,
    activeDuration: activeDurationSec,
    spanDuration: spanDurationSec,
    legCount,
    legs,
    longestInternalStopSec: Math.round(longestStopSec * 10) / 10,
    internalStopTime: Math.round(internalStopSec * 10) / 10,
    activeStartCoord: { lat: points[activeStartIdx].lat, lon: points[activeStartIdx].lon },
    activeEndCoord: { lat: points[activeEndIdx].lat, lon: points[activeEndIdx].lon },
    preTripIdle: preTripIdleSec,
    postTripIdle: postTripIdleSec,
    // стоянки внутри legs (светофоры/пробки < порога разбивки)
    activeIdleTime: Math.round(Math.max(0, Math.min(motion.idleTime - preTripIdleSec - postTripIdleSec, keptIdleSec)) * 10) / 10,
  };
}

// v2.25.0 (П.3): координата точки с timestamp ≥ ts (для границ leg из raw-границ)
function findCoordAtOrAfter(points: MethodologyPoint[], ts: number): { lat: number; lon: number } {
  for (const p of points) {
    if (p.timestamp >= ts) return { lat: p.lat, lon: p.lon };
  }
  return { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon };
}

function findCoordAtOrBefore(points: MethodologyPoint[], ts: number): { lat: number; lon: number } {
  let last = points[points.length - 1];
  for (const p of points) {
    if (p.timestamp > ts) break;
    last = p;
  }
  return { lat: last.lat, lon: last.lon };
}
