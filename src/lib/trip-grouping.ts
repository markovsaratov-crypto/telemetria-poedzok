// src/lib/trip-grouping.ts — v2.26.0 (ТЗ «Поездка не рвётся на куски», §4/§7/§13);
// v2.35.0 — ЖИВАЯ СКЛЕЙКА СОСТАВА (кейс 14.09: iOS-провал пуша 65 c посреди
// поездки создавал вторую запись; поездка-«хвост» показывала «1 запись» и
// замороженные статы первого фрагмента до финализации, а пересчёт финализации
// пересоздавал строку Trip — id менялся, план-джоб осиротевал). Теперь:
//   • joinNewSessionToTrip вливает новую запись в ПОЕЗДКУ ЦЕЛИКОМ: состав
//     (sessionIds/sessionCount/interFragmentGapSec), spanEnd, status=recording,
//     инвалидация кэшей метрик — карточка «Поездок» сразу показывает
//     «2 записи» и живые статы всего потока (computeTripStats по составу);
//   • матчинг пересчёта — по СТАРТУ ±120 c (startTime = первое движение —
//     стабильная идентичность цепочки): endTime у живой поездки «дышит»
//     (последняя точка батча), а канонический endTime — последнее ДВИЖЕНИЕ;
//     парковочный хвост после финиша раньше превышал допуск ±120 c →
//     delete+insert с новым id. Старт двух разных поездок устройства всегда
//     разделён ≥ TRIP_SPLIT_SEC — коллизий ±120 c нет;
//   • план-джоб при живой склейке НЕ сбрасывается (маршрут до финиша ещё
//     неизвестен) — его переустановит пересчёт финализации по drift'у окна.
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
import { libsql, batchChunked } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { inc } from "./metrics";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint, type ActiveTripLeg } from "./active-trip";
import { normalizeSessionSpeeds } from "./kpi"; // v2.40.7 (N-5): B-4 перед state machine

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
  // Точки по записям (ряд уже asc по timestamp — сортирует вызывающий) — нужно
  // ДО state machine: нормализация посессионно (ниже).
  const ptsBySession = new Map<string, RawPointRow[]>();
  for (const p of points) {
    let arr = ptsBySession.get(p.sessionId);
    if (!arr) {
      arr = [];
      ptsBySession.set(p.sessionId, arr);
    }
    arr.push(p);
  }
  // v2.40.7 (N-5 «битое поле speed режет поездки»): B-4-нормализация — КАК ВО
  // ВСЕХ остальных конвейерах (session-stats/events/track/share), только здесь
  // её не было. Прод-кейс 20.09 (ZIP-экспорт 920ff881): поле speed сдавало
  // мусорные 1–17 км/ч при реальных ~85 км/ч — cross-check state machine
  // min(speed, disp×1.5) брал мусорное поле, хвост записи (01:26–02:24, ~60 км)
  // становился «idle», поездка обрезалась на 01:26 при честной «Аналитике»
  // (её конвейер нормализует). Нормализация — ПОСЕССИОННО: критерий «глобальной
  // несогласованности» (медиана поля < 0,4×геометрии) — свойство ЗАПИСИ,
  // а не склейки; конкатенация нормализованных рядов снова сортируется —
  // порядок потока не меняется.
  const methodPoints: MethodologyPoint[] = [];
  for (const arr of ptsBySession.values()) {
    const sessPts: MethodologyPoint[] = arr.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      speed: p.speed,
      altitude: p.altitude,
      accuracy: p.accuracy,
      bearing: p.bearing,
      timestamp: p.timestamp,
    }));
    if (sessPts.length >= 2) {
      methodPoints.push(...normalizeSessionSpeeds(sessPts));
    } else {
      methodPoints.push(...sessPts);
    }
  }
  methodPoints.sort((a, b) => a.timestamp - b.timestamp); // инвариант глобального asc-потока
  const motion = computeMovingTime(methodPoints);
  const active = computeActiveTrip(methodPoints, motion, {
    splitSec: env().TRIP_SPLIT_SEC,
    minLegSec: env().ACTIVE_TRIP_MIN_LEG_SEC,
  });
  if (!active.hasActiveTrip || active.legs.length === 0) return [];

  // (группировка ptsBySession уже построена выше — до state machine)

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

  // Матчинг: тот же СТАРТ ±120 с. v2.35.0: startTime (первое движение) —
  // стабильная идентичность цепочки: старт двух разных поездок устройства
  // всегда разделён ≥ TRIP_SPLIT_SEC (между ними тишина/стоянка ≥ 900 c) —
  // коллизий допуска ±120 c не бывает. Раньше требовалось совпадение ещё и
  // endTime: у ЖИВОЙ поездки endTime «дышит» (extendTripOnPoints тянет его к
  // последней точке батча), а канонический endTime — последнее ДВИЖЕНИЕ;
  // парковочный хвост после финиша превышал допуск → delete+insert с новым
  // id (кейс 14.09: поездка 2e5f267b пересоздана как 659ab189 в 18:52).
  const MATCH_MS = 120_000;
  const matchedExisting = new Set<string>();
  const stmts: Array<{ sql: string; args: unknown[] }> = [];
  // v2.38.2 (ревью F55): id каждой вычисленной поездки (матч — стабильный id
  // существующей, новая — сгенерированный) — параллельно computed, в том же
  // (хронологическом) порядке; нужно для проставления Session.tripId ТЕМИ ЖЕ
  // стейтментами без перечтения Trip из БД (см. шаг 6).
  const computedTripIds: string[] = [];
  let created = 0;
  let updated = 0;

  for (const trip of computed) {
    const match = existing.find(
      (e) =>
        !matchedExisting.has(e.id) &&
        Math.abs(e.startTimeMs - trip.startTime) <= MATCH_MS
    );
    const sessionIdsJson = JSON.stringify(trip.sessionIds);
    const status = trip.hasRecordingSession ? "recording" : "completed";
    // v2.38.2 (F55): id разрешается ДО веток — одинаков для UPDATE и INSERT
    const tripIdResolved = match ? match.id : crypto.randomUUID();
    computedTripIds.push(tripIdResolved);
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
      const id = tripIdResolved; // v2.38.2 (F55): сгенерирован выше, единый источник
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
  // (шаг 6 ниже — ТЕМИ ЖЕ стейтментами, тем же batch).
  const windowSessionIds = sessions.map((s) => s.id);
  for (let i = 0; i < windowSessionIds.length; i += 50) {
    const chunk = windowSessionIds.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(", ");
    stmts.push({ sql: `UPDATE Session SET tripId = NULL WHERE id IN (${ph})`, args: chunk });
  }

  // ——— 6. Проставляем Session.tripId — в ТОТ ЖЕ batch (v2.38.2, ревью F55) ———
  // Раньше назначение шло ВТОРЫМ batch-ем ПОСЛЕ перечтения Trip из БД — окно
  // рассинхрона: между батчами Session.tripId=NULL при живых Trip.sessionIds;
  // сбой batch-2 (в т.ч. assignStmts > 500 → gateway 400) оставлял NULL до
  // следующего пересчёта. Составы известны В ПАМЯТИ (computed + матчинг
  // ±120 c, id стабильны — computedTripIds), перечтение не нужно: reset
  // (шаг 5) → assign (шаг 6) применяются ОДНИМ batch — на libsql всегда
  // атомарно, на D1 при ≤400 стейтментов (типичный пересчёт окна); свыше —
  // группы batchChunked в детерминированном порядке (восстановление —
  // идемпотентный повтор пересчёта, см. batchChunked в db.ts).
  // Порядок: computed — по возрастанию startTime; запись, входящая в
  // несколько поездок (запись на весь день), получает ПОСЛЕДНЮЮ — её UPDATE
  // выполняется последним и перекрывает предыдущие (семантика прежнего
  // «ORDER BY startTime ASC» при перечтении).
  for (let ti = 0; ti < computed.length; ti++) {
    const tripId = computedTripIds[ti];
    for (const sid of computed[ti].sessionIds) {
      stmts.push({ sql: `UPDATE Session SET tripId = ? WHERE id = ?`, args: [tripId, sid] });
    }
  }

  // Атомарное применение: libsql.batch = implicit transaction;
  // v2.38.2 (F55): ОДИН batchChunked на состав+назначение (было ДВА
  // последовательных libsql.batch с SELECT Trip между ними)
  if (stmts.length > 0) {
    try {
      await batchChunked(stmts);
    } catch (err) {
      logger.error("trip recompute batch failed", {
        requestId, deviceId, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
 * «поздние данные»; v2.35.0 — ПОЛНЫЙ СОСТАВ, кейс 14.09): батч, начинающийся
 * < TRIP_SPLIT_SEC после последнего фикса поездки, присоединяет запись к
 * поездке сразу (до вставки точек, под тем же ingestWriteLock).
 * v2.26.0 вливал только навигационное Session.tripId + spanEnd: карточка
 * «Поездок» до финализации показывала «1 запись» и ЗАМОРОЖЕННЫЕ статы
 * первого фрагмента (computeTripStats читает sessionIds). v2.35.0 обновляет
 * состав целиком — sessionIds/sessionCount/interFragmentGapSec, status=
 * 'recording', инвалидация кэшей метрик: карточка сразу показывает
 * «2 записи» и живые статы всего потока (поллинг /api/trips/[id] 15 c).
 * План-джоб НЕ сбрасывается: маршрут до финиша неизвестен — его переустановит
 * пересчёт финализации (drift окна: живой endTime = последняя точка,
 * канонический = последнее движение).
 * CAS по sessionIds (двойная попытка): параллельный recompute воркера мог
 * изменить состав между чтением и записью.
 * Полное расширение окна выполнит пересчёт при финализации.
 * @returns tripId если запись влита, null иначе
 */
export async function joinNewSessionToTrip(
  deviceId: string,
  sessionId: string,
  firstPointTsMs: number
): Promise<string | null> {
  if (!tripsEnabled()) return null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const lastRes = await libsql.execute({
        sql: `SELECT id, startTime, endTime, spanStart, spanEnd, sessionIds, sessionCount, interFragmentGapSec
              FROM Trip
              WHERE deviceId = ? AND deletedAt IS NULL ORDER BY spanStart DESC LIMIT 1`,
        args: [deviceId],
      });
      if (lastRes.rows.length === 0) return null;
      const t = lastRes.rows[0] as Record<string, unknown>;
      const tripId = String(t.id);
      // Граница цепочки = последний фикс поездки (spanEnd; живая парковка/хвост
      // уже включены). Фallback на endTime/startTime для вырожденных строк.
      const boundaryMs =
        t.spanEnd != null
          ? new Date(String(t.spanEnd)).getTime()
          : t.endTime != null
            ? new Date(String(t.endTime)).getTime()
            : new Date(String(t.startTime)).getTime();
      if (!Number.isFinite(boundaryMs)) return null;
      if (firstPointTsMs - boundaryMs >= env().TRIP_SPLIT_SEC * 1000) return null; // новая цепочка
      // Состав (канонический порядок — asc по времени вхождения; новая запись
      // всегда позже последнего фрагмента существующего состава)
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(String(t.sessionIds ?? "[]"));
        if (Array.isArray(parsed)) ids = parsed.map(String);
      } catch { /* битый JSON — пустой состав */ }
      if (ids.includes(sessionId)) return tripId; // уже влита (идемпотентность)
      const newIds = [...ids, sessionId];
      const gapSec = Math.max(0, Math.round(((firstPointTsMs - boundaryMs) / 1000) * 10) / 10);
      const prevGap = t.interFragmentGapSec == null || !Number.isFinite(Number(t.interFragmentGapSec))
        ? 0
        : Number(t.interFragmentGapSec);
      const now = new Date().toISOString();
      // CAS по sessionIds: состав под руками мог сменить recompute воркера
      const cas = await libsql.execute({
        sql: `UPDATE Trip SET
                sessionIds = ?, sessionCount = ?, interFragmentGapSec = ?,
                spanEnd = MAX(COALESCE(spanEnd, spanStart), ?), status = 'recording',
                activeDurationSec = NULL, distanceM = NULL, movingTimeSec = NULL, idleTimeSec = NULL,
                gapTimeSec = NULL, internalStopTimeSec = NULL, pointCountActual = NULL, maxSpeedMs = NULL,
                ecoScore = NULL, planDistanceM = NULL, planDurationSec = NULL, planComparable = NULL,
                planCoverage = NULL, routingLegCount = NULL, statsComputedAt = NULL,
                updatedAt = ?
              WHERE id = ? AND sessionIds = ? AND deletedAt IS NULL`,
        args: [
          JSON.stringify(newIds), newIds.length, Math.round((prevGap + gapSec) * 10) / 10,
          iso(firstPointTsMs), now, tripId, String(t.sessionIds ?? "[]"),
        ],
      });
      if ((cas.rowsAffected ?? 0) === 0) continue; // гонка — перечитываем состав
      inc("trip_live_join_total", "Live session joined into trip (full composition)", 1);
      logger.info("session live-joined into trip", {
        deviceId, sessionId, tripId,
        sessionCount: newIds.length, gapSec,
      });
      return tripId;
    }
    // CAS не прошёл дважды — состав назначит канонический пересчёт финализации
    return null;
  } catch (err) {
    logger.warn("trip live join failed (non-fatal)", {
      deviceId, sessionId, error: err instanceof Error ? err.message : String(err),
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
