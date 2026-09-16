// src/lib/trip-stats.ts — v2.26.0 (ТЗ «Поездка не рвётся», §8/§9).
//
// Конвейер метрик ПОЕЗДКИ = переиспользование session-stats.ts БЕЗ копипаста
// (анти-требование §16.7 ТЗ): источник данных поездки — конкатенированный поток
// точек её записей (ORDER BY timestamp), тот же computeSessionStats (state
// machine §4.6 → активное окно §4.11 → дистанции → методология §12 → EcoScore
// corpus §7.3 → спидограмма). Окна методологии пересекают стыки записей —
// EcoScore поездки НЕ среднее фрагментов (§16.8 ТЗ).
//
// Кэш: конвенция Session §6.1 — null = «не посчитано». Расчёт on-demand
// (GET /api/trips/[id], /api/trips/batch) пишет кэш в Trip.*; список /api/trips
// читает кэш без вычислений. Инвалидация — NULL-ение полей в trip-grouping
// при изменении состава/окна.
//
// План-факт (§9 ТЗ): ОДИН TrafficJob на поездку (tripId); разбор — тот же
// planFactFromJobResult (мульти-leg Σ, PLAN_MIN_COVERAGE-гейт), что и для записей.
//
// v2.38.0 — КЭШ ЧТЕНИЙ (оптимизация расхода D1): пересчёт читает ВСЕ точки
// состава (56К строк на полную вкладку «Поездки»), а фронтенд поллит
// /api/trips/batch каждые 30 с — главный жгут чтений БД. Теперь результат
// конвейера кэшируется в ПАМЯТИ процесса и валидируется ОТПЕЧАТКОМ строки
// Trip (tripFingerprint: состав sessionIds + окно startTime/endTime/spanStart/
// spanEnd + statsComputedAt) и ключом корпус-калибровки EcoScore. Любая
// инвалидация trip-grouping NULL-ит statsComputedAt → отпечаток меняется →
// пересчёт; продление живой поездки (extendTripOnPoints) двигает spanEnd →
// пересчёт; смену состава ловит sessionIds. План-факт читается СВЕЖИМ на каждый
// запрос (1 строка TrafficJob) — завершение маршрутного джоба видно сразу,
// без инвалидаций. Гигиена памяти: TTL 1 ч + LRU 128 (ttl-cache.ts, globalThis).
// Промах = прежний полный путь, включая запись кэш-полей Trip.* (теперь —
// только при реальном пересчёте, а не на каждый TTL-промах ответа).
import { libsql } from "./db";
import { logger } from "./logger";
import { inc } from "./metrics";
import { getTtlCache } from "./ttl-cache";
import { computeSessionStats, composeRoute, type RoutePlanFact, type FullSessionStatsPayload, type SessionStatsResult } from "./session-stats";
import { getCorpusEcoBaselines } from "./eco-corpus";
import type { EcoScoreBaselines } from "./metrics-methodology";
import type { MethodologyPoint } from "./active-trip";

export interface TripRow {
  id: string;
  deviceId: string;
  userId: string | null;
  status: string;
  startTime: string;
  endTime: string | null;
  spanStart: string;
  spanEnd: string | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  sessionIds: string[];
  sessionCount: number;
  interFragmentGapSec: number | null;
  trafficJobId: string | null;
  // кэш-поля
  activeDurationSec: number | null;
  distanceM: number | null;
  maxSpeedMs: number | null;
  ecoScore: number | null;
  pointCountActual: number | null;
  movingTimeSec: number | null;
  idleTimeSec: number | null;
  gapTimeSec: number | null;
  internalStopTimeSec: number | null;
  routingLegCount: number | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  planComparable: boolean | null;
  planCoverage: number | null;
  statsComputedAt: string | null;
}

interface RawTripRow {
  id: string;
  deviceId: string;
  userId: string | null;
  status: string;
  startTime: string;
  endTime: string | null;
  spanStart: string;
  spanEnd: string | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  sessionIds: string;
  sessionCount: number;
  interFragmentGapSec: number | null;
  trafficJobId: string | null;
  activeDurationSec: number | null;
  distanceM: number | null;
  maxSpeedMs: number | null;
  ecoScore: number | null;
  pointCountActual: number | null;
  movingTimeSec: number | null;
  idleTimeSec: number | null;
  gapTimeSec: number | null;
  internalStopTimeSec: number | null;
  routingLegCount: number | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  planComparable: number | null;
  planCoverage: number | null;
  statsComputedAt: string | null;
}

function parseSessionIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* ignore */ }
  return [];
}

export function mapTripRow(r: Record<string, unknown>): TripRow {
  const raw = r as unknown as RawTripRow;
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: String(raw.id),
    deviceId: String(raw.deviceId),
    userId: raw.userId == null ? null : String(raw.userId),
    status: String(raw.status),
    startTime: String(raw.startTime),
    endTime: raw.endTime == null ? null : String(raw.endTime),
    spanStart: String(raw.spanStart),
    spanEnd: raw.spanEnd == null ? null : String(raw.spanEnd),
    startLat: num(raw.startLat),
    startLon: num(raw.startLon),
    endLat: num(raw.endLat),
    endLon: num(raw.endLon),
    sessionIds: parseSessionIds(String(raw.sessionIds ?? "[]")),
    sessionCount: Number(raw.sessionCount ?? 0),
    interFragmentGapSec: num(raw.interFragmentGapSec),
    trafficJobId: raw.trafficJobId == null ? null : String(raw.trafficJobId),
    activeDurationSec: num(raw.activeDurationSec),
    distanceM: num(raw.distanceM),
    maxSpeedMs: num(raw.maxSpeedMs),
    ecoScore: num(raw.ecoScore),
    pointCountActual: raw.pointCountActual == null ? null : Number(raw.pointCountActual),
    movingTimeSec: num(raw.movingTimeSec),
    idleTimeSec: num(raw.idleTimeSec),
    gapTimeSec: num(raw.gapTimeSec),
    internalStopTimeSec: num(raw.internalStopTimeSec),
    routingLegCount: num(raw.routingLegCount),
    planDistanceM: num(raw.planDistanceM),
    planDurationSec: num(raw.planDurationSec),
    planComparable: raw.planComparable == null ? null : Boolean(raw.planComparable),
    planCoverage: num(raw.planCoverage),
    statsComputedAt: raw.statsComputedAt == null ? null : String(raw.statsComputedAt),
  };
}

/** Загрузка одной поездки по id. */
export async function loadTripById(tripId: string): Promise<TripRow | null> {
  const res = await libsql.execute({
    sql: `SELECT * FROM Trip WHERE id = ? AND deletedAt IS NULL`,
    args: [tripId],
  });
  if (res.rows.length === 0) return null;
  return mapTripRow(res.rows[0] as Record<string, unknown>);
}

/** Конкатенированный поток точек поездки (asc), чанками параллельно. */
export async function loadTripPoints(sessionIds: string[]): Promise<MethodologyPoint[]> {
  if (sessionIds.length === 0) return [];
  const CHUNK = 8;
  const chunks: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += CHUNK) chunks.push(sessionIds.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const ph = chunk.map(() => "?").join(", ");
      return libsql.execute({
        sql: `SELECT lat, lon, speed, altitude, accuracy, bearing, timestamp
              FROM GpsPoint WHERE sessionId IN (${ph}) ORDER BY timestamp ASC`,
        args: chunk,
      });
    })
  );
  const out: MethodologyPoint[] = [];
  for (const res of results) {
    for (const r of res.rows as Record<string, unknown>[]) {
      out.push({
        lat: Number(r.lat),
        lon: Number(r.lon),
        speed: r.speed == null ? null : Number(r.speed),
        altitude: r.altitude == null ? null : Number(r.altitude),
        accuracy: r.accuracy == null ? null : Number(r.accuracy),
        bearing: r.bearing == null ? null : Number(r.bearing),
        timestamp: Number(r.timestamp),
      });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export interface TripStatsPayload {
  tripId: string;
  pointCount: number;
  distance: number;
  rawDistanceM: number;
  duration: number; // span среза поездки, сек
  activeDurationSec: number; // «в поездке» (§4.11 активное окно)
  interFragmentGapSec: number;
  movingTime: number;
  idleTime: number;
  gapTime: number;
  internalStopTimeSec: number;
  avgSpeed: number | null;
  maxSpeed: number;
  ecoScore: number | null;
  speedProfile: FullSessionStatsPayload["speedProfile"];
  startTime: string;
  endTime: string | null;
  spanStart: string;
  spanEnd: string | null;
  methodology: FullSessionStatsPayload["methodology"];
  route: RoutePlanFact;
  routingLegCount: number | null;
}

/**
 * Полный расчёт статистики поездки — тот же конвейер, что у записи
 * (computeSessionStats), на конкатенированном потоке точек. План-факт — из
 * поездкового TrafficJob. Кэш пишется в Trip.* (null-поля означают «не
 * посчитано» — их вычислит следующий вызов).
 * v2.38.0: сначала — быстрый путь in-memory кэша (отпечаток строки + ключ
 * базлайнов); при совпадении полный конвейер не выполняется, докупается
 * только свежий план-факт (1 строка TrafficJob).
 */
export async function computeTripStats(
  trip: TripRow,
  baselines?: EcoScoreBaselines
): Promise<TripStatsPayload | null> {
  const eco = baselines ?? (await getCorpusEcoBaselines());
  const bk = baselinesKey(eco);

  // ——— Быстрый путь: состав/окно/инвалидации и базлайны не менялись ———
  const fp = tripFingerprint(trip);
  const hit = TRIP_CORE_CACHE.get(trip.id);
  if (hit != null && hit.fp === fp && hit.bk === bk) {
    inc("trip_stats_cache_hit_total", "Trip stats served from in-memory core cache", 1);
    const route = await tripPlanRoute(trip, hit.core);
    return assembleTripStatsPayload(trip, hit.core, route);
  }
  inc("trip_stats_cache_miss_total", "Trip stats recomputed (fingerprint/baselines changed or cold)", 1);

  const allPoints = await loadTripPoints(trip.sessionIds);
  if (allPoints.length === 0) return null;

  const spanStartMs = new Date(trip.spanStart).getTime();
  const spanEndMs = trip.spanEnd
    ? new Date(trip.spanEnd).getTime()
    : allPoints[allPoints.length - 1].timestamp;
  const spanSec = Math.max(0, (spanEndMs - spanStartMs) / 1000);

  // СРЕЗ ПОЕЗДКИ (ТЗ v2.26 §6: «одна запись может входить в несколько поездок —
  // в каждой поездке её СРЕЗ, не вся запись»): точки состава в окне
  // [spanStart, spanEnd]. Без среза запись на весь день (утренняя + вечерняя
  // поездки) отдавала КАЖДОЙ поездке все свои точки: обе карточки показывали
  // числа всей записи, а Σ вкладки «Поездки» считала общие интервалы дважды —
  // расходилось с «Аналитикой» (агрегат записей считает их один раз).
  // Живая поездка (spanEnd = null) — срез до последней точки (как раньше).
  const points = allPoints.filter(
    (p) => p.timestamp >= spanStartMs && p.timestamp <= spanEndMs
  );
  if (points.length === 0) return null;

  const result: SessionStatsResult = computeSessionStats(
    {
      id: trip.id,
      startTime: trip.spanStart,
      endTime: trip.spanEnd,
      routeHash: null,
      topologyHash: null,
    },
    points,
    eco
  );

  if (result.kind === "empty") return null;
  const core: TripStatsCore = {
    p: result.payload,
    activeDistanceM: result.activeDistanceM,
    actualDurationSec: result.actualDurationSec,
    avgSpeedRawMs: result.avgSpeedRawMs,
    spanSec,
  };

  // План-факт: поездковый джоб (tripId), разбор — planFactFromJobResult (§9 ТЗ)
  const route = await tripPlanRoute(trip, core);

  // Кэш в Trip (конвенция §6.1: null = «не посчитано»; сюда попадаем при
  // отсутствии кэша — маршрутизация/инвалидация уже NULL-нули поля).
  // v2.38.0: запись ТОЛЬКО на полном пути — быстрый путь не тратит квоту
  // записи D1 (раньше каждый TTL-промах ответа переписывал 15 строк Trip).
  const writtenAt = new Date().toISOString();
  let persisted = false;
  try {
    await libsql.execute({
      sql: `UPDATE Trip SET
              activeDurationSec = ?, movingTimeSec = ?, idleTimeSec = ?, gapTimeSec = ?,
              internalStopTimeSec = ?, interFragmentGapSec = ?, distanceM = ?,
              pointCountActual = ?, maxSpeedMs = ?, ecoScore = ?,
              planDistanceM = ?, planDurationSec = ?, planComparable = ?, planCoverage = ?,
              statsComputedAt = ?
            WHERE id = ?`,
      args: [
        round1(core.p.methodology?.activeTrip?.activeDuration ?? core.actualDurationSec),
        round1(core.p.movingTime),
        round1(core.p.idleTime),
        round1(core.p.gapTime),
        round1(core.p.methodology?.activeTrip?.internalStopTime ?? 0),
        round1(trip.interFragmentGapSec ?? 0),
        Math.round(core.p.distance),
        core.p.pointCount,
        core.p.maxSpeed,
        ecoClamped(core.p.methodology?.ecoScore?.value ?? null),
        route.planDistanceM,
        route.planDurationSec,
        route.planComparable,
        route.planCoverage,
        writtenAt,
        trip.id,
      ] as never[],
    });
    persisted = true;
  } catch (err) {
    logger.warn("trip stats cache write failed (non-fatal)", {
      tripId: trip.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  // Памятный отпечаток — под ЗНАЧЕНИЕ statsComputedAt, которое увидит следующий
  // читатель строки: свежезаписанное при успехе UPDATE, прежнее при сбое
  // (строка не изменилась). Гонки двух параллельных пересчётов сходятся к
  // значению последней записи — худший исход один лишний пересчёт, не ошибка.
  TRIP_CORE_CACHE.set(trip.id, {
    fp: tripFingerprint({ ...trip, statsComputedAt: persisted ? writtenAt : trip.statsComputedAt }),
    bk,
    core,
  });

  return assembleTripStatsPayload(trip, core, route);
}

/** Ядро конвейера статов — всё, что выводится из (точки ∩ окно, базлайны). */
interface TripStatsCore {
  p: FullSessionStatsPayload;
  activeDistanceM: number;
  actualDurationSec: number;
  avgSpeedRawMs: number | null;
  spanSec: number;
}

interface TripCoreCacheEntry {
  fp: string;
  bk: string;
  core: TripStatsCore;
}

const TRIP_CORE_CACHE = getTtlCache<TripCoreCacheEntry>("trips-stats-core", 60 * 60 * 1000, 128);

/** Отпечаток строки Trip: всё, от чего зависит конвейер статов. */
function tripFingerprint(t: TripRow): string {
  return [
    t.sessionIds.join(","),
    t.startTime,
    t.endTime ?? "",
    t.spanStart,
    t.spanEnd ?? "",
    t.statsComputedAt ?? "",
  ].join("|");
}

/** Ключ корпус-калибровки: сдвиг базлайнов EcoScore → пересчёт. */
function baselinesKey(b: EcoScoreBaselines): string {
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
  return `${b.version}:${b.corpusSize}:${r(b.braking)}:${r(b.accel)}:${r(b.jerk)}`;
}

/** Свежий план-факт поездки (1 строка TrafficJob) — мимо кэша сознательно:
 * маршрутный джоб может завершиться позже расчёта статов — план должен
 * появиться в карточке без ожидания инвалидации. */
async function tripPlanRoute(trip: TripRow, core: TripStatsCore): Promise<RoutePlanFact> {
  const facts = await loadPlanFactsByTrip([trip.id]);
  return composeRoute(facts.get(trip.id), core.activeDistanceM, core.actualDurationSec, core.avgSpeedRawMs);
}

function ecoClamped(v: number | null): number | null {
  return v != null ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

/** Сборка ответа из ТЕКУЩЕЙ строки Trip + кэшированного ядра конвейера
 * (поля строки — startTime/endTime/interFragmentGapSec — всегда свежие). */
function assembleTripStatsPayload(
  trip: TripRow,
  core: TripStatsCore,
  route: RoutePlanFact
): TripStatsPayload {
  const p = core.p;
  return {
    tripId: trip.id,
    pointCount: p.pointCount,
    distance: p.distance,
    rawDistanceM: p.rawDistanceM,
    duration: Math.round(core.spanSec),
    activeDurationSec: round1(p.methodology?.activeTrip?.activeDuration ?? core.actualDurationSec) ?? 0,
    interFragmentGapSec: trip.interFragmentGapSec ?? 0,
    movingTime: p.movingTime,
    idleTime: p.idleTime,
    // v2.31.0 (MIN-10): gapTime — только ВНУТРЕННИЕ разрывы записей состава
    // (dt>30c внутри фрагментов). На конкатенированном потоке стейт-машина
    // засчитывает и межфрагментные паузы (>30c) — те же минуты показывались
    // одновременно в тайлах «Паузы между записями» и «Разрывы». Вычитаем
    // interFragmentGapSec (учёт совпадает: обе стороны — полная длительность
    // паузы; clamp — на случай паузы <30c, которую стейт-машина гэпом не считает).
    gapTime: Math.max(0, (round1(p.gapTime) ?? 0) - (trip.interFragmentGapSec ?? 0)),
    internalStopTimeSec: round1(p.methodology?.activeTrip?.internalStopTime ?? 0) ?? 0,
    avgSpeed: p.avgSpeed,
    maxSpeed: p.maxSpeed,
    ecoScore: ecoClamped(p.methodology?.ecoScore?.value ?? null),
    speedProfile: p.speedProfile,
    startTime: trip.startTime,
    endTime: trip.endTime,
    spanStart: trip.spanStart,
    spanEnd: trip.spanEnd,
    methodology: p.methodology,
    route,
    routingLegCount: null, // заполняется из джоба воркера при наличии legCount
  };
}

function round1(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

/** Последние completed TrafficJob по списку ПОЕЗДОК (аналог loadPlanFacts). */
export async function loadPlanFactsByTrip(tripIds: string[]): Promise<Map<string, unknown>> {
  const facts = new Map<string, unknown>();
  if (tripIds.length === 0) return facts;
  try {
    const placeholders = tripIds.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT tripId, result FROM TrafficJob WHERE tripId IN (${placeholders}) AND status = 'completed' ORDER BY updatedAt ASC`,
      args: tripIds,
    });
    for (const row of res.rows as Record<string, unknown>[]) {
      const tid = String(row.tripId);
      if (row.result != null) facts.set(tid, row.result);
    }
  } catch {
    // сбой запроса = «плана нет», не роняет статы
  }
  return facts;
}
