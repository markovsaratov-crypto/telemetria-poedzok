// src/lib/session-stats.ts — v2.17.0: ЕДИНЫЙ конвейер SessionStats.
//
// Извлечён из /api/sessions/[id]/stats (дословно, без изменения семантики) и
// используется двумя роутами:
//   • GET /api/sessions/[id]/stats  — одиночная запись (как раньше);
//   • GET /api/stats/batch?ids=…    — батч-статс (запрос владельца 03.09:
//     «сделай батч статс эндпойнт» — пакет статистики для списка записей
//     одним запросом вместо N).
// Один код = одинаковые цифры. «Дословные реплики» конвейера (как у батя-статс
// в v2.15.0) — источник расхождений поверхностей, поэтому здесь их нет.
//
// Состав:
//   computeSessionStats()  — полный расчёт по сессии (FIX-C1 активное окно,
//     state machine §4.6, методология §12, спидограмма v2.9.3/4);
//   loadPlanFacts()        — последние completed TrafficJob по списку сессий
//     (один IN-запрос вместо N);
//   planFactFromJobResult()— чистый разбор plan-факта (§6.3/§6.6/§6.8);
//   EMPTY_PLAN_FACT        — «плана нет» (как было в computePlanFact).
import { libsql } from "./db";
import { computeMethodologyMetrics, type EcoScoreBaselines, type MethodologyMetrics } from "./metrics-methodology";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint } from "./active-trip";
import { avgSpeedMs, meanPointSpeedMs, maxSpeedMs, normalizeSessionSpeeds } from "./kpi";
import { haversineM } from "./geo";

// P1-7: план-фактные отклонения и трафик-блок из результата ворчера (§6.3/§6.6/§6.7/§6.8 методологии)
export interface RoutePlanFact {
  provider: string | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  trafficFetched: boolean;
  trafficDurationSec: number | null;
  timeLostToTrafficSec: number | null;
  durationDeviationPct: number | null;
  distanceDeviationPct: number | null;
  speedDeviationPct: number | null;
}

export const EMPTY_PLAN_FACT: RoutePlanFact = {
  provider: null,
  planDistanceM: null,
  planDurationSec: null,
  trafficFetched: false,
  trafficDurationSec: null,
  timeLostToTrafficSec: null,
  durationDeviationPct: null,
  distanceDeviationPct: null,
  speedDeviationPct: null,
};

export interface SessionStatsMeta {
  id: string;
  startTime: string;
  endTime: string | null;
  routeHash?: string | null;
  topologyHash?: string | null;
}

// ——— v2.9.3: спидограмма — даунсемпл GPS-точек для графика скорость-время ———
// v2.9.4: сэмпл расширен полями alt (высотный профиль) и lat/lng (связка карта↔график).
// st: 0 = idle (<2 км/ч), 1 = moving, 2 = gap (dt > 30 сек от предыдущей точки).
// Максимум SPEED_PROFILE_MAX точек; при меньшем числе точек — как есть.
const SPEED_PROFILE_MAX = 240;
export interface SpeedProfilePoint {
  t: number; // сек от начала сессии
  v: number | null; // км/ч (null — нет GPS-скорости у точки)
  st: 0 | 1 | 2;
  alt?: number | null; // м над уровнем моря (v2.9.4: высотный профиль)
  lat?: number; // v2.9.4: координата сэмпла для маркера на карте (5 знаков)
  lng?: number; // v2.9.4
}
export function buildSpeedProfile(
  points: Array<{
    speed: number | null;
    timestamp: number;
    altitude?: number | null;
    lat?: number;
    lon?: number;
  }>,
  startMs: number
): SpeedProfilePoint[] {
  if (points.length === 0) return [];
  // gap-флаги считаются на ИСХОДНОМ ряду (до даунсемпла), иначе при длинных
  // сессиях интервал сэмплов превысил бы 30с и дал ложные gap-детекты
  const gapFlag = new Array<boolean>(points.length).fill(false);
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp - points[i - 1].timestamp > 30_000) gapFlag[i] = true;
  }
  const step = Math.max(1, Math.ceil(points.length / SPEED_PROFILE_MAX));
  const out: SpeedProfilePoint[] = [];
  // v2.9.4: высотный ряд сглаживаем скользящим окном ±2 сэмпла исходного ряда —
  // GPS-высота шумит сильнее горизонтали, сырые значения дают «пилу» на графике
  const smoothAlt = (idx: number): number | null => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, idx - 2); j <= Math.min(points.length - 1, idx + 2); j++) {
      const a = points[j].altitude;
      if (a != null) {
        sum += a;
        n++;
      }
    }
    return n >= 2 ? Math.round((sum / n) * 10) / 10 : points[idx].altitude ?? null;
  };
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const t = Math.round((p.timestamp - startMs) / 1000);
    const kmh = p.speed != null && p.speed >= 0 ? Math.round(p.speed * 3.6 * 10) / 10 : null;
    // gap мог произойти между сэмплами — проверяем всё окно даунсемпла
    let isGap = gapFlag[i];
    if (!isGap) {
      for (let j = Math.max(1, i - step + 1); j < i; j++) {
        if (gapFlag[j]) {
          isGap = true;
          break;
        }
      }
    }
    const st: 0 | 1 | 2 = isGap ? 2 : kmh == null || kmh < 2 ? 0 : 1;
    const sample: SpeedProfilePoint = { t, v: kmh, st };
    // v2.9.4: высота (сглаженная) и координаты для связки с картой
    const alt = smoothAlt(i);
    if (alt != null) sample.alt = alt;
    if (typeof p.lat === "number" && typeof p.lon === "number") {
      sample.lat = Math.round(p.lat * 1e5) / 1e5;
      sample.lng = Math.round(p.lon * 1e5) / 1e5;
    }
    out.push(sample);
  }
  // хвостовая точка — чтобы график дотягивался до конца записи
  const last = points[points.length - 1];
  if (out.length === 0 || out[out.length - 1].t < (last.timestamp - startMs) / 1000 - 1) {
    const t = Math.round((last.timestamp - startMs) / 1000);
    const kmh =
      last.speed != null && last.speed >= 0 ? Math.round(last.speed * 3.6 * 10) / 10 : null;
    const sample: SpeedProfilePoint = { t, v: kmh, st: kmh != null && kmh >= 2 ? 1 : 0 };
    const lastAlt = points.length > 0 ? points[points.length - 1].altitude : null;
    if (lastAlt != null) sample.alt = lastAlt;
    if (typeof last.lat === "number" && typeof last.lon === "number") {
      sample.lat = Math.round(last.lat * 1e5) / 1e5;
      sample.lng = Math.round(last.lon * 1e5) / 1e5;
    }
    out.push(sample);
  }
  return out;
}

/** Пустой ответ для сессии без точек — форма прежнего early-return в stats-роуте. */
export interface EmptySessionStatsPayload {
  sessionId: string;
  pointCount: 0;
  distance: 0;
  duration: 0;
  avgSpeed: null;
  maxSpeed: null;
}

export interface FullSessionStatsPayload {
  sessionId: string;
  pointCount: number;
  // FIX-C1: distance — активная дистанция поездки (KPI); rawDistanceM — вся запись
  // (диагностика: сколько «накрутил» дрейф в хвостах)
  distance: number;
  rawDistanceM: number;
  duration: number;
  // v2.9.3: спидограмма для графика скорость-время
  speedProfile: SpeedProfilePoint[];
  // v2.9.4: есть ли высотные данные у сэмплов (иначе профиль высоты не рендерим)
  hasAltitude: boolean;
  // v2.9: из state machine (§4.6/§4.7)
  movingTime: number;
  idleTime: number;
  gapTime: number;
  // v2.9 §10.0: детерминированные хэши маршрута
  routeHash: string | null;
  topologyHash: string | null;
  // FIX-U2: точность 0,001 м/с — округление до 0,1 м/с давало расхождение поверхностей
  avgSpeed: number | null;
  // P2-13: средняя по точкам — отдельно от KPI AvgSpeed (§4.3)
  speedMeanMs: number | null;
  maxSpeed: number;
  avgAltitude: number | null;
  elevationGain: number;
  elevationLoss: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  startTime: string;
  endTime: string | null;
  methodology: MethodologyMetrics;
}

export type SessionStatsResult =
  | { kind: "empty"; payload: EmptySessionStatsPayload }
  | {
      kind: "full";
      payload: FullSessionStatsPayload;
      /** Сырая активная дистанция (до округления) — вход план-факта, как было. */
      activeDistanceM: number;
      /** §6.2/§6.3 FIX-C2: фактическое время = ActiveDuration, иначе вся запись. */
      actualDurationSec: number;
      /** AvgSpeed м/с без округления (FIX-U2 округляет только payload). */
      avgSpeedRawMs: number | null;
    };

/**
 * Полный расчёт статистики сессии — тот же конвейер, что был в
 * /api/sessions/[id]/stats (v2.16.0 и ранее), без изменений семантики:
 * normalizeSessionSpeeds (AUDIT B-4) → state machine §4.6 → активное окно
 * §4.11 (FIX-C1) → дистанции гаверсинусом → методология §12 → спидограмма.
 *
 * @param rawPoints точки сессии в порядке timestamp asc; timestamp — число (мс),
 *                  поле speed — сырое (нормализуется внутри)
 * @param ecoBaselines corpus-калибровка EcoScore (§7.3) — ОДНА на батч
 */
export function computeSessionStats(
  meta: SessionStatsMeta,
  rawPoints: MethodologyPoint[],
  ecoBaselines?: EcoScoreBaselines
): SessionStatsResult {
  const { id } = meta;

  // AUDIT B-4: нормализация скоростей — чинит сессии, где записанное поле speed
  // не соответствует геометрии (max 20 км/ч при 80-километровой поездке и т.п.).
  // Согласованным данным не меняет ничего.
  const points = normalizeSessionSpeeds(rawPoints);

  if (points.length === 0) {
    return {
      kind: "empty",
      payload: { sessionId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null },
    };
  }

  // Расчёт дистанций: FIX-C1 — аналитическая дистанция считается по АКТИВНОМУ ОКНУ
  // поездки (§4.11 [ActiveStartTime, ActiveEndTime]): дрейф GPS в «хвостах» (стоянка
  // до старта и после финиша) больше не накручивает дистанцию и AvgSpeed.
  // rawDistance (вся запись) отдаётся отдельно как rawDistanceM — для прозрачности.
  const motion = computeMovingTime(points);
  const activeTrip = computeActiveTrip(points, motion);
  const hasActive = activeTrip.hasActiveTrip;

  let distance = 0; // FIX-C1: активная дистанция (метрика KPI, план-факт, EcoScore)
  let rawDistance = 0; // вся запись (диагностика хвостов)
  let elevationGain = 0;
  let elevationLoss = 0;
  let prevAlt: number | null = null;

  // P2-13: maxSpeed через единый фильтр выбросов (kpi.ts) — GPS-джиттер раньше
  // давал нереальные значения MaxSpeed на экране
  const maxSpeed = maxSpeedMs(points) ?? 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    // Distance: raw — по всем интервалам, active — только внутри активного окна
    // (критерий тот же, что в route-comparison.ts: правая точка интервала ≥ старта,
    // левая ≤ финиша; интервалы «хвостовой» стоянки с её дрейфом отбрасываются)
    if (i > 0) {
      const prev = points[i - 1];
      const d = haversineM(prev.lat, prev.lon, p.lat, p.lon);
      rawDistance += d;
      if (hasActive && p.timestamp >= activeTrip.activeStartTime && prev.timestamp <= activeTrip.activeEndTime) {
        distance += d;
      }
    }

    // Elevation
    if (p.altitude != null) {
      if (prevAlt != null) {
        const diff = p.altitude - prevAlt;
        if (diff > 0) elevationGain += diff;
        else elevationLoss += Math.abs(diff);
      }
      prevAlt = p.altitude;
    }
  }

  const startTime = new Date(meta.startTime).getTime();
  const endTime = meta.endTime
    ? new Date(meta.endTime).getTime()
    : points.length > 0
    ? points[points.length - 1].timestamp
    : startTime;
  const durationSec = Math.max(0, (endTime - startTime) / 1000);

  // v2.9: метрики методологии (§12) — state machine + ActiveTrip + CAP EcoScore
  // v2.10.0 R6.1: EcoScore использует corpus-calibrated baselines
  // FIX-C1: в методологию передаётся АКТИВНАЯ дистанция
  // v2.18.0 (перф): motion/activeTrip уже посчитаны выше — передаём их в
  // методологию (раньше она пересчитывала state machine второй раз: самый
  // дорогой шаг конвейера ×2 на каждую сессию, ×50 в батче)
  const methodology = computeMethodologyMetrics(points, distance, durationSec, ecoBaselines, {
    motion,
    activeTrip: activeTrip,
  });
  // v2.9: AvgSpeed = Distance / ActiveDuration (§4.3 + §4.11)
  // FIX-C1: числитель и знаменатель — обе активные части. Нет поездки → null.
  const avgSpeed = hasActive ? avgSpeedMs(distance, durationSec, activeTrip.activeDuration) : null;
  const speedMean = meanPointSpeedMs(points);

  // Bounding box
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };

  // v2.9.3: спидограмма (даунсемпл ≤240 точек, сек от старта, км/ч, состояние)
  // v2.9.4: сэмплы дополнены alt/lat/lng (высотный профиль + связка с картой)
  const speedProfile = buildSpeedProfile(points, startTime);
  // v2.9.4: флаг наличия высотных данных (для показа высотного профиля в UI)
  const hasAltitude = speedProfile.some((p) => p.alt != null);

  // v2.18.0 (payload): states[] НЕ сериализуем — N−1 строк на сессию при
  // НУЛЕ потребителей (фронт-агрегатор всегда zeroes: v4-hooks `states: []`,
  // компонентов-читателей нет). 5k-точечная сессия ≈ 40 КБ мёртвого JSON в
  // каждом ответе [id]/stats и каждой из ≤50 записей батча. Массив остаётся
  // во внутреннем объекте методологии — пустой в копии для ответа.
  const methodologyForPayload: MethodologyMetrics = {
    ...methodology,
    motion: { ...methodology.motion, states: [] },
  };

  // v2.18.0: avgAltitude — по ВСЕМ точкам с высотой (раньше гейт был
  // prevAlt != null — высота ПОСЛЕДНЕЙ точки решала, считать ли среднее:
  // одна точка без высоты в конце обнуляла avgAltitude при 999 валидных).
  const altitudePoints = points.filter((p) => p.altitude != null);
  const avgAltitudeValue =
    altitudePoints.length > 0
      ? Math.round(altitudePoints.reduce((a, p) => a + (p.altitude || 0), 0) / altitudePoints.length)
      : null;

  return {
    kind: "full",
    payload: {
      sessionId: id,
      pointCount: points.length,
      distance: Math.round(distance),
      rawDistanceM: Math.round(rawDistance),
      duration: Math.round(durationSec),
      speedProfile,
      hasAltitude,
      movingTime: methodology.movingTime,
      idleTime: methodology.idleTime,
      gapTime: methodology.gapTime,
      routeHash: meta.routeHash ?? null,
      topologyHash: meta.topologyHash ?? null,
      avgSpeed: avgSpeed != null ? Math.round(avgSpeed * 1000) / 1000 : null,
      speedMeanMs: speedMean != null ? Math.round(speedMean * 10) / 10 : null,
      maxSpeed: Math.round(maxSpeed * 10) / 10,
      avgAltitude: avgAltitudeValue,
      elevationGain: Math.round(elevationGain),
      elevationLoss: Math.round(elevationLoss),
      bbox,
      startTime: meta.startTime,
      endTime: meta.endTime,
      methodology: methodologyForPayload,
    },
    activeDistanceM: distance,
    actualDurationSec: hasActive ? activeTrip.activeDuration : durationSec,
    avgSpeedRawMs: avgSpeed,
  };
}

/**
 * Последние completed TrafficJob по списку сессий — ОДИН IN-запрос
 * (v2.17.0; раньше N запросов по одному на сессию). Порядок ASC + перезапись
 * в Map → остаётся строка с максимальным updatedAt каждой сессии.
 * @returns Map<sessionId, сырое поле result (JSON-строка)>
 */
export async function loadPlanFacts(sessionIds: string[]): Promise<Map<string, unknown>> {
  const facts = new Map<string, unknown>();
  if (sessionIds.length === 0) return facts;
  try {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT sessionId, result FROM TrafficJob WHERE sessionId IN (${placeholders}) AND status = 'completed' ORDER BY updatedAt ASC`,
      args: sessionIds,
    });
    for (const row of res.rows as Record<string, unknown>[]) {
      const sid = String(row.sessionId);
      if (row.result != null) facts.set(sid, row.result); // поздние строки перезаписывают ранние
    }
  } catch {
    // сбой запроса = «плана нет», не роняет статы (как было в computePlanFact)
  }
  return facts;
}

/**
 * Чистый разбор plan-факта из JSON-результата TrafficJob — та же логика, что
 * была в computePlanFact (§6.3/§6.6/§6.7/§6.8): 2ГИС-трафик → план по базовой
 * линии гаверсинус/40 км/ч; отклонения с 2 знаками (v2.13.0 Ф5).
 * @returns null — джобы нет / битый JSON (вызывающий подставит EMPTY_PLAN_FACT)
 */
export function planFactFromJobResult(
  rawResult: unknown,
  actualDistanceM: number,
  actualDurationSec: number,
  actualAvgSpeed: number | null
): RoutePlanFact | null {
  if (rawResult == null) return null;
  let parsed: unknown;
  try { parsed = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult; } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const plan = parsed as Record<string, unknown>; // v2.16.0 (V5): вместо any
  const provider = plan.provider ? String(plan.provider) : null;

  // План: дистанция провайдера — всегда плановая (геометрия маршрута).
  // Время: для OSRM — свободный поток (план); для 2ГИС total_duration включает пробки →
  // план по времени считаем по базовой линии гаверсинус/40 км/ч (§3.2), трафик — от 2ГИС.
  const distM = Number(plan.distanceM) || null;
  const durS = Number(plan.durationSec) || null;
  const trafficFetched = !!plan.trafficFetched;
  const planDistanceM = distM;
  let planDurationSec = trafficFetched ? null : durS;
  let trafficDurationSec = trafficFetched ? durS : null;
  let timeLostToTrafficSec: number | null = null;

  if (trafficFetched && durS && distM) {
    const direct =
      Array.isArray(plan.segments) && (plan.segments as Array<{ lat: number; lon: number }>).length >= 2
        ? haversineM((plan.segments as Array<{ lat: number; lon: number }>)[0].lat, (plan.segments as Array<{ lat: number; lon: number }>)[0].lon, (plan.segments as Array<{ lat: number; lon: number }>)[(plan.segments as Array<{ lat: number; lon: number }>).length - 1].lat, (plan.segments as Array<{ lat: number; lon: number }>)[(plan.segments as Array<{ lat: number; lon: number }>).length - 1].lon)
        : null;
    if (direct && direct > 1) {
      const baselineDur = Math.round((direct / 1000 / 40) * 3600); // гаверсинус @ 40 км/ч
      planDurationSec = baselineDur;
      timeLostToTrafficSec = durS - baselineDur; // §6.8
    }
  }

  // v2.13.0 (Ф5): 2 знака после запятой (владелец: «должна иметь 2 знака»).
  const pct = (actual: number, plan: number) =>
    plan > 0 ? Math.round(((actual - plan) / plan) * 10000) / 100 : null;

  let speedDeviationPct: number | null = null;
  if (actualAvgSpeed != null && planDistanceM && planDurationSec && planDurationSec > 0) {
    const planSpeed = planDistanceM / planDurationSec;
    speedDeviationPct = planSpeed > 0 ? Math.round(((actualAvgSpeed - planSpeed) / planSpeed) * 1000) / 10 : null;
  }
  // §6.7: если план по времени недоступен (2ГИС-трафик) — скорость плана = дистанция плана / трафик-время
  if (speedDeviationPct == null && actualAvgSpeed != null && planDistanceM && trafficDurationSec && trafficDurationSec > 0) {
    const trafficSpeed = planDistanceM / trafficDurationSec;
    speedDeviationPct = trafficSpeed > 0 ? Math.round(((actualAvgSpeed - trafficSpeed) / trafficSpeed) * 1000) / 10 : null;
  }

  return {
    provider,
    planDistanceM: planDistanceM ? Math.round(planDistanceM) : null,
    planDurationSec,
    trafficFetched,
    trafficDurationSec,
    timeLostToTrafficSec: timeLostToTrafficSec != null ? Math.round(timeLostToTrafficSec) : null,
    durationDeviationPct: planDurationSec ? pct(actualDurationSec, planDurationSec) : null,
    distanceDeviationPct: planDistanceM ? pct(actualDistanceM, planDistanceM) : null,
    speedDeviationPct,
  };
}

/**
 * Композиция route-блока для полной сессии: джоб есть → разбор; нет → EMPTY.
 */
export function composeRoute(
  jobResult: unknown,
  actualDistanceM: number,
  actualDurationSec: number,
  actualAvgSpeed: number | null
): RoutePlanFact {
  return planFactFromJobResult(jobResult, actualDistanceM, actualDurationSec, actualAvgSpeed) ?? { ...EMPTY_PLAN_FACT };
}
