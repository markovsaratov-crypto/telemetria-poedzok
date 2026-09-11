// src/lib/trip-grouping.ts — v2.26.0 (ТЗ «Поездка не рвётся на куски», §4/§7/§13).
//
// КАНОНИЧЕСКОЕ ПРАВИЛО ГРАНИЦ ПОЕЗДКИ (§4 ТЗ) — чистая функция потока точек
// устройства, записи в ней НЕ участвуют:
//
//   Поездка = максимальная последовательность точек одного устройства, в которой
//   любые две соседние точки разделены интервалом < TRIP_SPLIT_SEC, а стоянка
//   (нулевое перемещение при наличии точек) длится < TRIP_SPLIT_SEC.
//
//   Границу создают ТОЛЬКО: интервал между точками ≥ TRIP_SPLIT_SEC (тишина
//   логгера / потеря GPS — любая природа), стоянка ≥ TRIP_SPLIT_SEC (живой
//   парковочный дрейф), смена устройства, soft-delete записи.
//
// РЕАЛИЗАЦИЯ = переиспользование legs-механизма v2.25 БЕЗ копипаста (§8 ТЗ):
// computeMovingTime + computeActiveTrip на КОНКАТЕНИРОВАННОМ потоке точек
// устройства с splitSec=TRIP_SPLIT_SEC: внутренние стоянки/тишины ≥ порога
// режут legs — каждый leg и есть окно одной поездки. Тождественность
// семантик гарантирована инвариантом env TRIP_SPLIT_SEC == ACTIVE_TRIP_STOP_SPLIT_SEC.
//
// ЕДИНАЯ ТОЧКА ПРАВДЫ: recomputeTripsForDevice() — единственный код правила;
// инкрементальное назначение при финализации (assignTripOnSessionFinalize),
// пересчёт при удалении записи и backfill истории вызывают ЕЁ (§7 ТЗ:
// «инкрементальное назначение ≡ полный пересчёт»).
//
// КОНТРОЛЬНАЯ СУММА ПОЕЗДКИ (§4 ТЗ): Σ Duration(фрагментов) + Σ межфрагментных
// пауз = TripSpan. interFragmentGapSec хранится на Trip; при нарушении (NaN,
// отрицательный span) — warn-лог с tripId, тихих деградаций нет (§16 ТЗ).
import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { inc } from "./metrics";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint, type ActiveTripLeg } from "./active-trip";

/** Точка загрузки точек из БД (сырые строки GpsPoint). */
interface RawPointRow {
  sessionId: string;
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null;
  timestamp: number; // мс
}

interface SessionRow {
  id: string;
  userId: string | null;
  deviceId: string;
  startTime: string;
  endTime: string | null;
  status: string;
}

/** Результат канонического правила: вычисленные поездки окна. */
interface ComputedTrip {
  startTime: number; // мс первого движения (leg.startTime)
  endTime: number; // мс последнего движения (leg.endTime)
  spanStart: number; // первый фикс среза потока поездки (для первой поездки цепочки — с пре-idle хвостом)
  spanEnd: number; // = endTime: парковка между поездками не принадлежит никому
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  sessionIds: string[]; // asc по времени первого вхождения в окно
  interFragmentGapSec: number; // Σ пауз между соседними записями внутри поездки
  userId: string | null;
  hasRecordingSession: boolean;
}

export function tripsEnabled(): boolean {
  return env().TRIP_ENABLED === "true";
}

/** Контрольная сумма поездки: span = Σ длительностей фрагментов + Σ пауз (§4 ТЗ). */
export function checkTripControlSum(trip: { spanStart: number; spanEnd: number; interFragmentGapSec: number }, fragmentDurSec: number): boolean {
  const spanSec = (trip.spanEnd - trip.spanStart) / 1000;
  const expect = fragmentDurSec + trip.interFragmentGapSec;
  const ok = Number.isFinite(spanSec) && Number.isFinite(expect) && Math.abs(spanSec - expect) < 2.5;
  if (!ok) {
    logger.warn("trip control sum violated", {
      spanSec: Math.round(spanSec * 10) / 10,
      fragmentsSec: Math.round(fragmentDurSec * 10) / 10,
      gapsSec: Math.round(trip.interFragmentGapSec * 10) / 10,
    });
  }
  return ok;
}

/** Загрузка точек списка сессий — чанками параллельно (паттерн batch-points.ts). */
async function loadPointsChunked(sessionIds: string[]): Promise<RawPointRow[]> {
  if (sessionIds.length === 0) return [];
  const CHUNK = 8;
  const chunks: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += CHUNK) chunks.push(sessionIds.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const ph = chunk.map(() => "?").join(", ");
      return libsql.execute({
        sql: `SELECT sessionId, lat, lon, speed, altitude, accuracy, bearing, timestamp
              FROM GpsPoint WHERE sessionId IN (${ph}) ORDER BY timestamp ASC`,
        args: chunk,
      });
    })
  );
  const out: RawPointRow[] = [];
  for (const res of results) {
    for (const r of res.rows as Record<string, unknown>[]) {
      out.push({
        sessionId: String(r.sessionId),
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
  return out;
}

/**
 * Каноническое правило на потоке точек (§4 ТЗ). points — конкатенированный
 * поток устройства (asc по timestamp), sessions — мета записей этого потока.
 * Возвращает поездки: leg'и computeActiveTrip(splitSec=TRIP_SPLIT_SEC) + состав.
 */
export function computeTripsFromPoints(points: RawPointRow[], sessions: SessionRow[]): ComputedTrip[] {
  if (points.length === 0) return [];
  const methodPoints: MethodologyPoint[] = points.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    speed: p.speed,
    altitude: p.altitude,
    accuracy: p.accuracy,
    bearing: p.bearing,
    timestamp: p.timestamp,
  }));
  const motion = computeMovingTime(methodPoints);
  const active = computeActiveTrip(methodPoints, motion, {
    splitSec: env().TRIP_SPLIT_SEC,
    minLegSec: env().ACTIVE_TRIP_MIN_LEG_SEC,
  });
  if (!active.hasActiveTrip || active.legs.length === 0) return [];

  // Точки по записям (глобальный ряд уже asc) — срез-границы записи ВНУТРИ
  // конкретной поездки (запись на весь день: её утренняя часть ≠ вся запись)
  const ptsBySession = new Map<string, RawPointRow[]>();
  for (const p of points) {
    let arr = ptsBySession.get(p.sessionId);
    if (!arr) {
      arr = [];
      ptsBySession.set(p.sessionId, arr);
    }
    arr.push(p);
  }

  const legs: ActiveTripLeg[] = active.legs;
  const trips: ComputedTrip[] = [];

  // Binary search: индекс первой точки с timestamp > ts (ряд отсортирован asc)
  const lowerBound = (ts: number): number => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].timestamp <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const sliceEnd = leg.endTime;
    const prevLegEnd = i > 0 ? legs[i - 1].endTime : -Infinity;

    // ——— Левая граница среза (QA-фикс: тишина vs живая парковка) ———
    // Срез = [scanFrom, sliceEnd]. Дискриминатор — что шло после конца
    // предыдущей поездки:
    //   • ТИШИНА ≥ TRIP_SPLIT_SEC → следующая цепочка точек начинается с
    //     пре-idle хвоста (холодный GPS 05:53 при движении с 05:55) — хвост
    //     принадлежит ЭТОЙ поездке (кап 900 c: стояние дольше — уже «до поездки»);
    //   • ЖИВЫЕ точки (парковка непрерывно) — парковка между поездками не
    //     принадлежит никому: срез начинается с ДВИЖЕНИЯ (leg.startTime).
    // Для первого leg потока — пре-idle хвост от начала потока (кап 900 c).
    // Тишины (dt ≥ TRIP_SPLIT_SEC) внутри (prevLegEnd, leg.startTime):.Slice
    // начинается после ПОСЛЕДНЕЙ такой тишины (парковка после поездки могла
    // продолжаться живыми точками, тишина наступила позже — например хвост
    // записи на следующий день: 05:53 при движении с 05:55). Нет тишин —
    // парковка непрерывна, срез начинается с движения.
    let scanFrom = leg.startTime;
    let silenceFound = false;
    const windowStart = i > 0 ? prevLegEnd : -Infinity;
    const idx0 = Math.max(0, lowerBound(windowStart) - 1);
    for (let k = idx0; k + 1 < points.length; k++) {
      const p0 = points[k];
      const p1 = points[k + 1];
      if (p1.timestamp >= leg.startTime) break;
      if (p0.timestamp >= windowStart && p1.timestamp - p0.timestamp >= env().TRIP_SPLIT_SEC * 1000) {
        // последняя тишина перед leg: цепочка начинается с p1
        scanFrom = Math.max(p1.timestamp, leg.startTime - env().TRIP_SPLIT_SEC * 1000);
        silenceFound = true;
      }
    }
    if (i === 0 && !silenceFound) {
      // Первый leg окна БЕЗ тишин (поток начинается с пре-idle, например
      // подокно с 05:53:31 при движении с 05:55): хвост ≤ 900 c — часть
      // поездки. Если тишина НАЙДЕНА — она уже задала границу точнее.
      scanFrom = Math.max(points[0].timestamp, leg.startTime - env().TRIP_SPLIT_SEC * 1000);
    }

    // ——— Членство и срезы: точки записи в [scanFrom, sliceEnd] ———
    // Одна запись может входить в НЕСКОЛЬКО поездок (запись на весь день =
    // утренняя + вечерняя): в каждой поездке — её СРЕЗ, не вся запись.
    const memberFirst = new Map<string, number>();
    const memberLast = new Map<string, number>();
    const memberIds: string[] = [];
    for (const s of sessions) {
      const arr = ptsBySession.get(s.id);
      if (!arr || arr.length === 0) continue;
      // точки записи отсортированы внутри глобального ряда; ищем срез
      let fs: number | null = null;
      let ls: number | null = null;
      for (const p of arr) {
        if (p.timestamp < scanFrom) continue;
        if (p.timestamp > sliceEnd) break;
        if (fs === null) fs = p.timestamp;
        ls = p.timestamp;
      }
      if (fs !== null && ls !== null) {
        memberFirst.set(s.id, fs);
        memberLast.set(s.id, ls);
        memberIds.push(s.id);
      }
    }
    if (memberIds.length === 0) continue; // вырожденный leg без записей — guard

    const sorted = [...memberIds].sort(
      (a, b) => (memberFirst.get(a) ?? 0) - (memberFirst.get(b) ?? 0)
    );
    const sliceStart = scanFrom;

    // Σ пауз между СРЕЗАМИ соседних записей (контрольная сумма §4 ТЗ:
    // span = Σ длительностей срезов + Σ пауз — срез, не вся запись!)
    let interGapSec = 0;
    let slicesDurSec = 0;
    for (let j = 0; j < sorted.length; j++) {
      const f = memberFirst.get(sorted[j]) ?? 0;
      const l = memberLast.get(sorted[j]) ?? 0;
      slicesDurSec += Math.max(0, (l - f) / 1000);
      if (j > 0) {
        const prevEnd = memberLast.get(sorted[j - 1]) ?? 0;
        const gap = (f - prevEnd) / 1000;
        if (gap > 0) interGapSec += gap;
      }
    }
    if (sorted.length > 1) {
      checkTripControlSum(
        { spanStart: sliceStart, spanEnd: sliceEnd, interFragmentGapSec: Math.round(interGapSec * 10) / 10 },
        slicesDurSec
      );
    }

    const sessById = new Map(sessions.map((s) => [s.id, s]));
    trips.push({
      startTime: leg.startTime,
      endTime: leg.endTime,
      spanStart: sliceStart,
      spanEnd: sliceEnd,
      startLat: leg.startCoord.lat,
      startLon: leg.startCoord.lon,
      endLat: leg.endCoord.lat,
      endLon: leg.endCoord.lon,
      sessionIds: sorted,
      interFragmentGapSec: Math.round(interGapSec * 10) / 10,
      userId: sessById.get(sorted[0])?.userId ?? null,
      hasRecordingSession: sorted.some((sid) => sessById.get(sid)?.status === "recording"),
    });
  }
  return trips;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * ЕДИНСТВЕННАЯ реализация правила для БД: пересчитывает поездки устройства
 * от fromMs (включительно) до конца истории. Идемпотентна: повторный запуск
 * сходится к тому же состоянию (существующие поездки матчатся по окну ±120 с,
 * id стабильны — дип-линки/кэши переживают пересчёт).
 *
 * Состав применяется атомарно (libsql.batch = транзакция): сначала вычисляем
 * новое состояние полностью, потом записываем (§7 ТЗ «конверт»).
 *
 * @returns число созданных/обновлённых/удалённых поездок (для метрик/бэкфилла)
 */
export async function recomputeTripsForDevice(
  deviceId: string,
  fromMs: number,
  opts?: { requestId?: string }
): Promise<{ created: number; updated: number; deleted: number }> {
  const requestId = opts?.requestId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  // ——— 1. Записи окна: не удалённые, чей конец ≥ границы (запись, spans
  // границу, входит целиком — её точки нужны для полного leg-окна), asc.
  const sessRes = await libsql.execute({
    sql: `SELECT id, userId, deviceId, startTime, endTime, status FROM Session
          WHERE deviceId = ? AND deletedAt IS NULL AND (endTime IS NULL OR endTime >= ?)
          ORDER BY startTime ASC`,
    args: [deviceId, new Date(fromMs - 1).toISOString()],
  });
  const sessions: SessionRow[] = (sessRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    userId: r.userId == null ? null : String(r.userId),
    deviceId: String(r.deviceId),
    startTime: String(r.startTime),
    endTime: r.endTime == null ? null : String(r.endTime),
    status: String(r.status),
  }));
  if (sessions.length === 0) return { created: 0, updated: 0, deleted: 0 };

  // ——— 2. Конкатенированный поток точек (asc) ———
  const points = await loadPointsChunked(sessions.map((s) => s.id));
  points.sort((a, b) => a.timestamp - b.timestamp);

  // ——— 3. Каноническое правило ———
  const computed = computeTripsFromPoints(points, sessions);
  const streamFirstTs = points.length > 0 ? points[0].timestamp : fromMs;

  // ——— 4. Diff с существующими поездками устройства ———
  const existingRes = await libsql.execute({
    sql: `SELECT id, startTime, endTime, spanStart, spanEnd, sessionIds, sessionCount, status, userId
          FROM Trip WHERE deviceId = ? AND deletedAt IS NULL ORDER BY spanStart ASC`,
    args: [deviceId],
  });
  interface ExistingTrip {
    id: string;
    startTimeMs: number;
    endTimeMs: number;
    sessionIds: string[];
    sessionCount: number;
  }
  const existing: ExistingTrip[] = [];
  for (const r of existingRes.rows as Record<string, unknown>[]) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(String(r.sessionIds ?? "[]"));
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch { /* битый JSON — treated as empty */ }
    existing.push({
      id: String(r.id),
      startTimeMs: new Date(String(r.startTime)).getTime(),
      endTimeMs: r.endTime == null ? 0 : new Date(String(r.endTime)).getTime(),
      sessionIds: ids,
      sessionCount: Number(r.sessionCount ?? 0),
    });
  }

  // Матчинг: то же окно движения ±120 с (стабильные id при пересчёте)
  const MATCH_MS = 120_000;
  const matchedExisting = new Set<string>();
  const stmts: Array<{ sql: string; args: unknown[] }> = [];
  let created = 0;
  let updated = 0;

  for (const trip of computed) {
    const match = existing.find(
      (e) =>
        !matchedExisting.has(e.id) &&
        Math.abs(e.startTimeMs - trip.startTime) <= MATCH_MS &&
        Math.abs(e.endTimeMs - trip.endTime) <= MATCH_MS
    );
    const sessionIdsJson = JSON.stringify(trip.sessionIds);
    const status = trip.hasRecordingSession ? "recording" : "completed";
    if (match) {
      matchedExisting.add(match.id);
      const compositionChanged =
        JSON.stringify(match.sessionIds) !== sessionIdsJson ||
        Math.abs(match.endTimeMs - trip.endTime) > 1000;
      // Обновление окна/состава; при изменении — инвалидация кэшей метрик и плана
      stmts.push({
        sql: `UPDATE Trip SET startTime = ?, endTime = ?, spanStart = ?, spanEnd = ?,
                startLat = ?, startLon = ?, endLat = ?, endLon = ?,
                sessionIds = ?, sessionCount = ?, interFragmentGapSec = ?, userId = ?, status = ?,
                ${compositionChanged ? "activeDurationSec = NULL, distanceM = NULL, movingTimeSec = NULL, idleTimeSec = NULL, gapTimeSec = NULL, internalStopTimeSec = NULL, pointCountActual = NULL, maxSpeedMs = NULL, ecoScore = NULL, planDistanceM = NULL, planDurationSec = NULL, planComparable = NULL, planCoverage = NULL, routingLegCount = NULL, statsComputedAt = NULL," : ""}
                updatedAt = ?
              WHERE id = ?`,
        args: [
          iso(trip.startTime), iso(trip.endTime), iso(trip.spanStart), iso(trip.spanEnd),
          trip.startLat, trip.startLon, trip.endLat, trip.endLon,
          sessionIdsJson, trip.sessionIds.length, trip.interFragmentGapSec, trip.userId, status,
          now, match.id,
        ],
      });
      if (compositionChanged) {
        updated++;
        // План поездки устарел — переустановка джоба (§7 ТЗ: «план-джоб переустанавливается»)
        stmts.push({
          sql: `UPDATE TrafficJob SET status = 'pending', attempts = 0, error = NULL, lockedBy = NULL, lockedAt = NULL, scheduledFor = ?, updatedAt = ?
                WHERE tripId = ? AND status IN ('completed', 'dead', 'pending', 'failed')`,
          args: [now, now, match.id],
        });
        if (status === "completed") {
          // completed-джоба могло не быть вовсе — ensureTripTrafficJob ниже (вне batch)
        }
      }
      if (match.sessionCount !== trip.sessionIds.length) inc("trip_fragments_joined_total", "Fragments joined into existing trip", 1);
    } else {
      const id = crypto.randomUUID();
      created++;
      stmts.push({
        sql: `INSERT INTO Trip (id, deviceId, userId, status, startTime, endTime, spanStart, spanEnd,
                startLat, startLon, endLat, endLon, sessionIds, sessionCount, interFragmentGapSec,
                createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id, deviceId, trip.userId, status,
          iso(trip.startTime), iso(trip.endTime), iso(trip.spanStart), iso(trip.spanEnd),
          trip.startLat, trip.startLon, trip.endLat, trip.endLon,
          sessionIdsJson, trip.sessionIds.length, trip.interFragmentGapSec,
          now, now,
        ],
      });
      matchedExisting.add(id); // не матчим дважды
      if (status === "completed") {
        // Новая закрытая поездка — план-джоб (§9 ТЗ: один TrafficJob на поездку)
        const jobId = crypto.randomUUID();
        stmts.push({
          sql: `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
                SELECT ?, ?, 'pending', 0, 0, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`,
          args: [jobId, id, now, now, id],
        });
        stmts.push({
          sql: `UPDATE Trip SET trafficJobId = COALESCE(
                  (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
                WHERE id = ? AND trafficJobId IS NULL`,
          args: [id, id],
        });
      }
      if (trip.sessionIds.length > 1) inc("trip_fragments_joined_total", "Fragments joined into new trip", 1);
    }
  }

  // Удаление поездок, не подтверждённых пересчётом: только те, чей конец
  // попадает в пересчитанное окно (прошлые цепочки до окна неприкосновенны).
  const windowStart = streamFirstTs - MATCH_MS;
  const deletedIds: string[] = [];
  for (const e of existing) {
    if (matchedExisting.has(e.id)) continue;
    if (e.endTimeMs < windowStart) continue; // до окна — чужая история
    deletedIds.push(e.id);
  }
  for (const id of deletedIds) {
    stmts.push({ sql: `DELETE FROM Trip WHERE id = ?`, args: [id] });
    stmts.push({ sql: `DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')`, args: [id] });
  }
  if (deletedIds.length > 0) {
    const ph = deletedIds.map(() => "?").join(", ");
    stmts.push({ sql: `UPDATE Session SET tripId = NULL WHERE tripId IN (${ph})`, args: deletedIds });
  }

  // ——— 5. Session.tripId: последняя поездка записи (навигация) ———
  // Сначала сбрасываем у всех записей окна, потом проставляем по составам
  // (шаг 6 ниже, отдельным батчем — поездки уже записаны).
  const windowSessionIds = sessions.map((s) => s.id);
  for (let i = 0; i < windowSessionIds.length; i += 50) {
    const chunk = windowSessionIds.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(", ");
    stmts.push({ sql: `UPDATE Session SET tripId = NULL WHERE id IN (${ph})`, args: chunk });
  }

  // Атомарное применение (libsql.batch = implicit transaction)
  if (stmts.length > 0) {
    try {
      await libsql.batch(stmts.map((s) => ({ sql: s.sql, args: s.args as never[] })));
    } catch (err) {
      logger.error("trip recompute batch failed", {
        requestId, deviceId, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  // ——— 6. Проставляем Session.tripId (после batch — отдельным батчем) ———
  // Перечитываем поездки окна (id стабильны) в порядке startTime ASC: записи,
  // входящие в несколько поездок (запись на весь день), получают ПОСЛЕДНЮЮ —
  // её UPDATE выполняется последним и перекрывает предыдущие.
  const afterRes = await libsql.execute({
    sql: `SELECT id, sessionIds FROM Trip WHERE deviceId = ? AND deletedAt IS NULL AND spanEnd >= ? ORDER BY startTime ASC`,
    args: [deviceId, new Date(windowStart).toISOString()],
  });
  const assignStmts: Array<{ sql: string; args: unknown[] }> = [];
  for (const r of afterRes.rows as Record<string, unknown>[]) {
    const tripId = String(r.id);
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(String(r.sessionIds ?? "[]"));
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch { /* ignore */ }
    for (const sid of ids) {
      assignStmts.push({ sql: `UPDATE Session SET tripId = ? WHERE id = ?`, args: [tripId, sid] });
    }
  }
  if (assignStmts.length > 0) {
    await libsql.batch(assignStmts.map((s) => ({ sql: s.sql, args: s.args as never[] })));
  }

  inc("trip_recompute_total", "Trip recompute runs", 1);
  if (deletedIds.length > 0) inc("trip_split_total", "Trips deleted by recompute (split/orphan)", deletedIds.length);
  logger.info("trips recomputed", {
    requestId, deviceId,
    sessions: sessions.length, points: points.length,
    trips: computed.length, created, updated, deleted: deletedIds.length,
  });
  return { created, updated, deleted: deletedIds.length };
}

/**
 * Инкрементальное назначение при финализации записи (§7 ТЗ).
 * Окно пересчёта = вся затронутая цепочка: от начала ПОСЛЕДНЕЙ поездки устройства
 * (если новая запись вливается в неё) или от начала самой записи. Ранние поездки
 * разделены ≥ TRIP_SPLIT_SEC тишиной — вне окна не меняются.
 * Не бросает наверх: сбой назначения не роняет финализацию (warn-лог, §16 ТЗ).
 */
export async function assignTripOnSessionFinalize(sessionId: string): Promise<void> {
  if (!tripsEnabled()) return;
  try {
    const sessRes = await libsql.execute({
      sql: `SELECT id, deviceId, startTime FROM Session WHERE id = ?`,
      args: [sessionId],
    });
    if (sessRes.rows.length === 0) return;
    const s = sessRes.rows[0] as Record<string, unknown>;
    const deviceId = String(s.deviceId);
    const sessionStartMs = new Date(String(s.startTime)).getTime();

    // Последняя поездка устройства: если запись вливается в неё — пересчёт
    // от её начала (вся цепочка), иначе от начала записи.
    const lastTripRes = await libsql.execute({
      sql: `SELECT startTime FROM Trip WHERE deviceId = ? AND deletedAt IS NULL ORDER BY spanStart DESC LIMIT 1`,
      args: [deviceId],
    });
    let fromMs = sessionStartMs - env().TRIP_SPLIT_SEC * 1000; // запас на границу
    if (lastTripRes.rows.length > 0) {
      const lastTripStart = new Date(String((lastTripRes.rows[0] as Record<string, unknown>).startTime)).getTime();
      if (Number.isFinite(lastTripStart)) fromMs = Math.min(fromMs, lastTripStart - 5_000);
    }
    await recomputeTripsForDevice(deviceId, fromMs);
  } catch (err) {
    logger.warn("trip assignment after finalize failed (non-fatal)", {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * «Жнец» поездок (§7 ТЗ п.4): поездка закрывается (completed), когда от её
 * конца прошло > TRIP_SPLIT_SEC и ни одна запись не пишется. Вызывается тем же
 * циклом воркера, что «жнец» записей; сбой не мешает остальному циклу.
 * Закрытие ставит план-джоб, если его ещё нет (§9 ТЗ).
 */
export async function closeStaleTrips(): Promise<number> {
  if (!tripsEnabled()) return 0;
  const cutoff = new Date(Date.now() - env().TRIP_SPLIT_SEC * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = await libsql.execute({
    sql: `SELECT t.id FROM Trip t
          WHERE t.status = 'recording' AND t.deletedAt IS NULL AND t.spanEnd < ?
            AND NOT EXISTS (SELECT 1 FROM Session s WHERE s.tripId = t.id AND s.status = 'recording')
          LIMIT 10`,
    args: [cutoff],
  });
  let closed = 0;
  for (const r of stale.rows as Record<string, unknown>[]) {
    const tripId = String(r.id);
    const jobId = crypto.randomUUID();
    await libsql.batch([
      {
        sql: `UPDATE Trip SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
        args: [now, tripId],
      },
      {
        sql: `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
              SELECT ?, ?, 'pending', 0, 0, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`,
        args: [jobId, tripId, now, now, tripId],
      },
      {
        sql: `UPDATE Trip SET trafficJobId = COALESCE(
                (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
              WHERE id = ? AND trafficJobId IS NULL`,
        args: [tripId, tripId],
      },
    ]);
    closed++;
  }
  return closed;
}

/**
 * Пересчёт после soft-delete записи (§7 ТЗ): соседние поездки устройства в
 * окне ±1 ч пересчитываются каноническим правилом (могут склеиться).
 */
export async function recomputeAfterSessionDelete(sessionId: string): Promise<void> {
  if (!tripsEnabled()) return;
  try {
    const sessRes = await libsql.execute({
      sql: `SELECT deviceId, startTime, endTime FROM Session WHERE id = ?`,
      args: [sessionId],
    });
    if (sessRes.rows.length === 0) return;
    const s = sessRes.rows[0] as Record<string, unknown>;
    const deviceId = String(s.deviceId);
    const startMs = new Date(String(s.startTime)).getTime();
    const endMs = s.endTime == null ? Date.now() : new Date(String(s.endTime)).getTime();
    const margin = env().TRIP_SPLIT_SEC * 1000;
    // Окно: поездки, которые могли включать удалённую запись (начались раньше
    // её старта) и поездки-соседи (могли склеиться после удаления).
    const fromMs = startMs - margin;
    const toMs = endMs + margin;
    void toMs; // верхняя граница — вся история устройства после fromMs (recompute до конца)
    await recomputeTripsForDevice(deviceId, fromMs);
  } catch (err) {
    logger.warn("trip recompute after delete failed (non-fatal)", {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Живое вливание записи в существующую поездку при СОЗДАНИИ записи (§7 ТЗ
 * «поздние данные»): батч, начинающийся < TRIP_SPLIT_SEC после последней
 * точки поездки, присоединяет запись к поездке сразу (до вставки точек,
 * под тем же ingestWriteLock). Полное расширение окна выполнит пересчёт
 * при финализации; здесь — навигационное tripId + живое расширение span.
 * @returns tripId если запись влита, null иначе
 */
export async function joinNewSessionToTrip(deviceId: string, firstPointTsMs: number): Promise<string | null> {
  if (!tripsEnabled()) return null;
  try {
    const lastRes = await libsql.execute({
      sql: `SELECT id, endTime FROM Trip
            WHERE deviceId = ? AND deletedAt IS NULL ORDER BY spanStart DESC LIMIT 1`,
      args: [deviceId],
    });
    if (lastRes.rows.length === 0) return null;
    const t = lastRes.rows[0] as Record<string, unknown>;
    const tripId = String(t.id);
    const endMs = t.endTime == null ? 0 : new Date(String(t.endTime)).getTime();
    if (!Number.isFinite(endMs)) return null;
    if (firstPointTsMs - endMs >= env().TRIP_SPLIT_SEC * 1000) return null; // новая цепочка
    const now = new Date().toISOString();
    await libsql.execute({
      sql: `UPDATE Trip SET spanEnd = MAX(COALESCE(spanEnd, spanStart), ?), status = 'recording', updatedAt = ?
            WHERE id = ?`,
      args: [iso(firstPointTsMs), now, tripId],
    });
    return tripId;
  } catch (err) {
    logger.warn("trip join on session create failed (non-fatal)", {
      deviceId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Живое расширение окна поездки при добавлении точек в привязанную запись
 * (инжест батча): spanEnd/endTime едут за последней точкой. Вызывается из
 * инжеста под writeLock; полный пересчёт состава — при финализации.
 */
export async function extendTripOnPoints(sessionId: string, lastPointTsMs: number): Promise<void> {
  if (!tripsEnabled()) return;
  try {
    const now = new Date().toISOString();
    await libsql.execute({
      sql: `UPDATE Trip SET
              spanEnd = MAX(COALESCE(spanEnd, spanStart), ?),
              endTime = MAX(COALESCE(endTime, startTime), ?),
              updatedAt = ?
            WHERE id = (SELECT tripId FROM Session WHERE id = ?)`,
      args: [iso(lastPointTsMs), iso(lastPointTsMs), now, sessionId],
    });
  } catch {
    // диагностика живого окна — молча (не роняет инжест)
  }
}
