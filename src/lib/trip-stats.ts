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
import { libsql } from "./db";
import { logger } from "./logger";
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
 */
export async function computeTripStats(
  trip: TripRow,
  baselines?: EcoScoreBaselines
): Promise<TripStatsPayload | null> {
  const points = await loadTripPoints(trip.sessionIds);
  if (points.length === 0) return null;

  const spanStartMs = new Date(trip.spanStart).getTime();
  const spanEndMs = trip.spanEnd ? new Date(trip.spanEnd).getTime() : points[points.length - 1].timestamp;
  const spanSec = Math.max(0, (spanEndMs - spanStartMs) / 1000);

  const eco = baselines ?? (await getCorpusEcoBaselines());
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
  const p = result.payload;

  // План-факт: поездковый джоб (tripId), разбор — planFactFromJobResult (§9 ТЗ)
  const facts = await loadPlanFactsByTrip([trip.id]);
  const route = composeRoute(
    facts.get(trip.id),
    result.activeDistanceM,
    result.actualDurationSec,
    result.avgSpeedRawMs
  );

  // Кэш в Trip (конвенция §6.1: null = «не посчитано»; сюда попадаем при
  // отсутствии кэша — маршрутизация/инвалидация уже NULL-нули поля)
  const ecoValue = p.methodology?.ecoScore?.value ?? null;
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
        round1(p.methodology?.activeTrip?.activeDuration ?? result.actualDurationSec),
        round1(p.movingTime),
        round1(p.idleTime),
        round1(p.gapTime),
        round1(p.methodology?.activeTrip?.internalStopTime ?? 0),
        round1(trip.interFragmentGapSec ?? 0),
        Math.round(p.distance),
        p.pointCount,
        p.maxSpeed,
        ecoValue != null ? Math.max(0, Math.min(100, Math.round(ecoValue))) : null,
        route.planDistanceM,
        route.planDurationSec,
        route.planComparable,
        route.planCoverage,
        new Date().toISOString(),
        trip.id,
      ] as never[],
    });
  } catch (err) {
    logger.warn("trip stats cache write failed (non-fatal)", {
      tripId: trip.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    tripId: trip.id,
    pointCount: p.pointCount,
    distance: p.distance,
    rawDistanceM: p.rawDistanceM,
    duration: Math.round(spanSec),
    activeDurationSec: round1(p.methodology?.activeTrip?.activeDuration ?? result.actualDurationSec) ?? 0,
    interFragmentGapSec: trip.interFragmentGapSec ?? 0,
    movingTime: p.movingTime,
    idleTime: p.idleTime,
    gapTime: p.gapTime,
    internalStopTimeSec: round1(p.methodology?.activeTrip?.internalStopTime ?? 0) ?? 0,
    avgSpeed: p.avgSpeed,
    maxSpeed: p.maxSpeed,
    ecoScore: ecoValue != null ? Math.max(0, Math.min(100, Math.round(ecoValue))) : null,
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
