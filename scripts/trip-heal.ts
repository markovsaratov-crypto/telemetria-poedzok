// scripts/trip-heal.ts — GHA-движок лечения «кусков поездок» (CR-G, 2026-10-01).
//
// ЗАЧЕМ (docs/OPERATIONS.md §14 — полные выводы):
//   RC1 «фейковые поездки»: fmAdoptOrphans (воркер v3) усыновляет сирот
//       pointCount≥3 БЕЗ проверки движения → стоянка с открытым приложением
//       становится «поездкой» 0 км / 0 мин движения и мусорит вкладку
//       «Поездки» и аналитику (5 шт за 30.09).
//   RC2 «сироты-сердцебиения»: телефон в фоне шлёт 1-точечные батчи каждые
//       5 мин; SESSION_GAP_MS прод-шлюза = 60 c (биндинга нет, дефолт) →
//       каждое сердцебиение = НОВАЯ сессия → десятки мусорных записей/день
//       накачивают счётчики аналитики (78 сессий за 30.09).
//   RC3 «недосклейки»: спека рвёт поездку на любом стоянии/тишине ≥ 900 c
//       (TRIP_SPLIT_SEC) — стоянка 15…30 мин между двумя ездами одного
//       выезда выглядит для пользователя «порванной» поездкой.
//
// ЧТО ДЕЛАЕТ (каждый шаг идемпотентен и лимитирован; сырые GpsPoint
// НЕ трогаются ВООБЩЕ — только Session.deletedAt / Trip / TrafficJob):
//   1. retireStaticTrips: Trip с честными метриками (statsComputedAt NOT
//      NULL) и distanceM < 100 м И movingTimeSec < 60 c → отцепить сессии
//      (tripId=NULL), удалить pending/running-джобы, DELETE Trip (как
//      recomputeTripsForDevice приложения — сырьё восстановимо backfill'ом).
//   2. softDeleteStandingOrphans: осиротевшие (tripId NULL) completed-сессии
//      без ДВИЖЕНИЯ (maxSpeed < 2 м/с И bbox < 250 м) → Session.deletedAt
//      (мягкое удаление: точки остаются, FM-роллап и выборки приложения
//      сами исключают deletedAt — счётчики аналитики самоочищаются, часовой
//      refresh7d шлюза пересчитает замороженные дни).
//   3. mergeUndercutPairs: соседние Trip одного устройства с гэпом
//      < TRIP_MERGE_MAX_SEC (дефолт 1800 с — «один выезд со стоянкой до
//      30 минут») → слияние в keeper (a) — точная копия стейтментов
//      fmMergeUndercut воркера; метрики обнуляются → тsw-прогрев шлюза
//      пересчитает их сам через GET /api/trips/batch (методология приложения).
//   4. deviceSilentAudit: устройство, молчащее 3+ ч при живом расписании
//      (локальные часы 7..23) → запись AuditLog action='device.silent'
//      (троттлинг: полосы 3-9 ч и 21-27 ч + проверка «не писали ли за
//      последние 20 ч» по индексу action,createdAt).
//   5. repairDanglingRefs (CR-H 2026-10-03): сессии, чей tripId указывает
//      на НЕСУЩЕСТВУЮЩУЮ поездку (жертвы конкурентных писателей Trip —
//      движки adopt/merge шлюза против recomputeTripsForDevice приложения
//      в разных каденсах) — данные таких сессий невидимы во вкладке
//      «Поездки» и не входят в метрики. Стационарные (bbox < 250 м,
//      скорость смещения < 1.4 м/с — ТОЛЬКО геометрия: поле speed мусорит,
//      кейс 06b81f98 7337 м/с при 2.9 км, 8953bbd9 51 м/с при нулевом
//      bbox) → soft-delete; движущиеся → tripId = NULL (adopt-движок
//      воркера создаст поездку на ближайшем тике).
//   6. warmStats (CR-H): воркер v3 (прод) греет ≤1 поездку/тик с 6ч-KV-
//      голоданием (исправлено в v3.1, не задеплоено) → свежие поездки
//      показывают «— км» в списке (метрики из БД, ленивый persist только
//      при просмотре детали). Здесь: completed-поездки со statsComputedAt
//      IS NULL и spanEnd старше 10 мин → GET {APP_ORIGIN}/api/trips/batch
//      с Bearer apiKey владельца (методология приложения, persist там же).
//
// ЗАПУСК: bun scripts/trip-heal.ts (env: D1_GATEWAY_URL, D1_GATEWAY_SECRET;
// опционально TRIP_MERGE_MAX_SEC, HEAL_TZ, HEAL_DRY_RUN, HEAL_DEEP,
// APP_ORIGIN — дефолт https://poedzok.fun).
// Контракт шлюза: POST /query {sql,params} и POST /batch {statements} —
// заголовок x-gateway-secret; воркер НЕ в read-only (GATEWAY_READ_ONLY не
// задан), вайтлист таблиц покрывает Session/Trip/TrafficJob/AuditLog.
//
// ЭТО МОСТ: после деплоя d1-gateway v3.1 (OPERATIONS.md §14 рунбук —
// движки переезжают в воркер, SESSION_GAP_MS=900000 убивает фабрику сирот
// на корню) cron этого workflow отключить (оставить workflow_dispatch
// как ручной инструмент).
export {}; // ES-модуль (top-level await)

// ——— конфиг из окружения ———
const GW_URL = process.env.D1_GATEWAY_URL ?? "";
const GW_SECRET = process.env.D1_GATEWAY_SECRET ?? "";
// v2 (CR-I, 03.10): дефолт 900 c = TRIP_SPLIT_SEC — ЕДИНЫЙ порог по METHODOLOGY.md
// (§4.11/§4.11а: пауза >= 900 c — граница поездки). Окно 1800 (прошлый раунд)
// давало флип-флоп: мост клеил <= 30 мин, приложение тут же рвало по 900 c.
const MERGE_MAX_SEC = Number(process.env.TRIP_MERGE_MAX_SEC) > 0 ? Number(process.env.TRIP_MERGE_MAX_SEC) : 900;
const MERGE_MAX_MS = MERGE_MAX_SEC * 1000;
const TZ = process.env.HEAL_TZ ?? "Europe/Saratov";
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "https://poedzok.fun").replace(/\/+$/, "");
const DRY_RUN = (process.env.HEAL_DRY_RUN ?? "") === "true";
const DEEP = (process.env.HEAL_DEEP ?? "") === "true";
if (!GW_URL || !GW_SECRET) {
  console.error("missing D1_GATEWAY_URL / D1_GATEWAY_SECRET");
  process.exit(1);
}
const BASE = GW_URL.replace(/\/+$/, "");

// ——— лимиты на прогон (страховка от шторма записей) ———
const RETIRE_LIMIT = 4;
const SOFT_DELETE_LIMIT = 40;
const MERGE_LIMIT = 3;
const MAX_SESSION_POINTS_FOR_CHECK = 3000; // очень большие сироты — движку воркера
const DANGLING_LIMIT = 50;
const WARM_LIMIT = 8;

// ——— SQL-клиент шлюза ———
interface GwRow {
  [k: string]: unknown;
}
async function gwCall(path: string, body: unknown): Promise<unknown[]> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": GW_SECRET },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gateway ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as unknown;
    if (Array.isArray(json)) return json as unknown[];
    if (json && typeof json === "object" && Array.isArray((json as { rows?: unknown[] }).rows)) {
      return [(json as { rows: unknown[] }).rows];
    }
    return [json];
  } finally {
    clearTimeout(tm);
  }
}
async function q(sql: string, params: unknown[] = []): Promise<GwRow[]> {
  const out = await gwCall("/query", { sql, params });
  const rows = out[0];
  return Array.isArray(rows) ? (rows as GwRow[]) : [];
}
async function qBatch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]> {
  const out = await gwCall("/batch", { statements });
  return out.map((r) => Number((r as { rowsAffected?: number }).rowsAffected ?? 0));
}

// ——— хелперы ———
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function parseIds(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    if (Array.isArray(v)) return v.map(String);
  } catch {
    /* битый JSON → пусто */
  }
  return [];
}
async function sessionBound(ids: string[], agg: "MAX(endTime)" | "MIN(startTime)"): Promise<number | null> {
  let acc: number | null = null;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(", ");
    const rows = await q(`SELECT ${agg} AS v FROM Session WHERE id IN (${ph}) AND deletedAt IS NULL`, chunk);
    const v = rows[0]?.v;
    const ms = v == null ? NaN : Date.parse(String(v));
    if (!Number.isFinite(ms)) continue;
    if (acc == null) acc = ms;
    else acc = agg.startsWith("MAX") ? Math.max(acc, ms) : Math.min(acc, ms);
  }
  return acc;
}
function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

// ——— прогон ———
const t0 = Date.now();
const now = Date.now();
const nowIso = iso(now);
const summary = { dryRun: DRY_RUN, deep: DEEP, retired: 0, softDeleted: 0, skippedMoving: 0, merged: 0, mergeSkipped: 0, audits: 0, repaired: 0, warmed: 0, errors: [] as string[] };

try {
  // ============ 0) repairDanglingRefs (CR-H 2026-10-03) ============
  // Сессии, чей tripId указывает на несуществующую поездку: стационарные
  // (геометрия!) — soft-delete, движущиеся — освободить (tripId = NULL) для
  // adopt-движка воркера. Дискриминатор ТОЛЬКО bbox/скорость смещения — поле
  // speed непригодно (мусорные 51–7337 м/с при нулевом bbox, известный N-5).
  try {
    const danglings = await q(
      `SELECT s.id, s.deviceId, s.startTime, s.endTime, s.pointCount FROM Session s
        WHERE s.tripId IS NOT NULL AND s.deletedAt IS NULL
          AND s.tripId NOT IN (SELECT id FROM Trip)
        ORDER BY s.startTime ASC LIMIT ${DANGLING_LIMIT}`
    );
    for (const s of danglings) {
      const sid = String(s.id);
      const pc = Number(s.pointCount ?? 0);
      if (pc <= 0 || pc > MAX_SESSION_POINTS_FOR_CHECK) continue;
      const m = (await q(
        `SELECT COUNT(*) AS n, MIN(lat) AS minLat, MAX(lat) AS maxLat, MIN(lon) AS minLon, MAX(lon) AS maxLon
           FROM GpsPoint WHERE sessionId = ?`,
        [sid]
      ))[0];
      const n = Number(m?.n ?? 0);
      if (n === 0) continue; // нет точек — не наш мусор
      const latSpanM = Math.abs(Number(m.maxLat) - Number(m.minLat)) * 111_320;
      const midLat = (Number(m.maxLat) + Number(m.minLat)) / 2;
      const lonSpanM = Math.abs(Number(m.maxLon) - Number(m.minLon)) * 111_320 * Math.cos((midLat * Math.PI) / 180);
      const bboxMaxM = Math.max(latSpanM, lonSpanM);
      const durSec = Math.max(Math.abs(Date.parse(String(s.endTime ?? s.startTime)) - Date.parse(String(s.startTime))) / 1000, 60);
      const rateStill = bboxMaxM / durSec < 1.4; // < 5 км/ч — не поездка
      if (bboxMaxM < 250 && rateStill) {
        log({ t: "heal:repairDangling", sessionId: sid, mode: "softDelete", deviceId: String(s.deviceId), points: pc, bboxM: Math.round(bboxMaxM), dryRun: DRY_RUN });
        if (!DRY_RUN) {
          await qBatch([{ sql: "UPDATE Session SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL", params: [nowIso, nowIso, sid] }]);
        }
        summary.softDeleted++;
      } else {
        log({ t: "heal:repairDangling", sessionId: sid, mode: "release", deviceId: String(s.deviceId), points: pc, bboxM: Math.round(bboxMaxM), dryRun: DRY_RUN });
        if (!DRY_RUN) {
          await qBatch([{ sql: "UPDATE Session SET tripId = NULL, updatedAt = ? WHERE id = ?", params: [nowIso, sid] }]);
        }
        summary.repaired++;
      }
    }
  } catch (e) {
    summary.errors.push(`repairDangling: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ============ 1) retireStaticTrips ============
  const fakes = await q(
    `SELECT id, deviceId, startTime, endTime, sessionCount FROM Trip
      WHERE deletedAt IS NULL AND statsComputedAt IS NOT NULL
        AND distanceM IS NOT NULL AND distanceM < 100
        AND movingTimeSec IS NOT NULL AND movingTimeSec < 60
      ORDER BY updatedAt DESC LIMIT ${RETIRE_LIMIT}` // свежие фейки первыми — они в текущем UI юзера
  );
  for (const f of fakes) {
    const id = String(f.id);
    log({ t: "heal:retire", tripId: id, deviceId: String(f.deviceId), startTime: String(f.startTime), distLt: 100, movLt: 60, dryRun: DRY_RUN });
    // состав фейка ДО открепления (для мягкого удаления доказанно стационарных сессий)
    const fakeIds = parseIds((await q("SELECT sessionIds AS ids FROM Trip WHERE id = ?", [id]))[0]?.ids);
    if (!DRY_RUN) {
      await qBatch([
        { sql: "UPDATE Session SET tripId = NULL, updatedAt = ? WHERE tripId = ? AND deletedAt IS NULL", params: [nowIso, id] },
        { sql: "DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')", params: [id] },
        { sql: "DELETE FROM Trip WHERE id = ?", params: [id] },
      ]);
      // v2: сессии фейка, на которые НЕ ссылается ни одна другая живая поездка,
      // — мягко удаляем (метрики поездки 0 км — стационарность доказана
      // приложением): иначе adopt-движок воркера ПЕРЕСОЗДАСТ фейк из сироты
      // (флип-флоп retire↔adopt, кейс 01.10 f53153d4)
      for (const sid of fakeIds) {
        try {
          const ref = await q(
            "SELECT count(*) AS c FROM Trip WHERE deletedAt IS NULL AND id <> ? AND sessionIds LIKE ?",
            [id, `%"${sid}"%`]
          );
          if (Number(ref[0]?.c ?? 0) === 0) {
            await qBatch([{ sql: "UPDATE Session SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL AND tripId IS NULL", params: [nowIso, nowIso, sid] }]);
            log({ t: "heal:retireSession", sessionId: sid, ofTrip: id, dryRun: DRY_RUN });
          }
        } catch {
          /* ссылку не проверили — оставим сессию живой (safe) */
        }
      }
    }
    summary.retired++;
  }

  // ============ 2) softDeleteStandingOrphans ============
  const sinceMs = now - (DEEP ? 30 : 2) * 86_400_000;
  const orphans = await q(
    `SELECT id, deviceId, startTime, endTime, pointCount FROM Session
      WHERE tripId IS NULL AND status = 'completed' AND deletedAt IS NULL AND startTime > ?
      ORDER BY startTime DESC LIMIT ${SOFT_DELETE_LIMIT}`,
    [iso(sinceMs)]
  );
  for (const s of orphans) {
    const sid = String(s.id);
    const pc = Number(s.pointCount ?? 0);
    if (pc <= 0 || pc > MAX_SESSION_POINTS_FOR_CHECK) continue; // пустые/гиганты — не нам
    const m = (await q(
      `SELECT COUNT(*) AS n, MAX(speed) AS maxSpeed, MIN(lat) AS minLat, MAX(lat) AS maxLat, MIN(lon) AS minLon, MAX(lon) AS maxLon
         FROM GpsPoint WHERE sessionId = ?`,
      [sid]
    ))[0];
    const n = Number(m?.n ?? 0);
    if (n === 0) continue; // нет точек — оставляем (не наш мусор)
    const maxSpeed = m?.maxSpeed == null ? null : Number(m.maxSpeed);
    const minLat = Number(m?.minLat);
    const maxLat = Number(m?.maxLat);
    const minLon = Number(m?.minLon);
    const maxLon = Number(m?.maxLon);
    const latSpanM = Math.abs(maxLat - minLat) * 111_320;
    const midLat = (maxLat + minLat) / 2;
    const lonSpanM = Math.abs(maxLon - minLon) * 111_320 * Math.cos((midLat * Math.PI) / 180);
    const speedStill = maxSpeed == null || maxSpeed < 2.0; // < 7,2 км/ч
    const bboxMaxM = Math.max(latSpanM, lonSpanM);
    const bboxStill = bboxMaxM < 250;
    // v2 (кейс f53153d4 01.10): стоянка с GPS-дрейфом (bbox 250-400 м при
    // accuracy 16-52 м) — дискриминатор СКОРОСТЬ СМЕЩЕНИЯ: bbox/длительность
    // < 1,4 м/с (5 км/ч — пешеход) при maxSpeed < 2 — это не поездка.
    // Реальная езда даёт либо maxSpeed ≥ 2 (стоп-н-гоу), либо км-масштаб bbox.
    const durSec = Math.max(Math.abs(Date.parse(String(s.endTime ?? s.startTime)) - Date.parse(String(s.startTime))) / 1000, 60);
    const rateStill = bboxMaxM / durSec < 1.4;
    if (speedStill && (bboxStill || rateStill)) {
      log({ t: "heal:softDelete", sessionId: sid, deviceId: String(s.deviceId), startTime: String(s.startTime), points: pc, maxSpeed, bboxM: Math.round(bboxMaxM), rateMs: +(bboxMaxM / durSec).toFixed(2), dryRun: DRY_RUN });
      if (!DRY_RUN) {
        await qBatch([
          { sql: "UPDATE Session SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL", params: [nowIso, nowIso, sid] },
        ]);
      }
      summary.softDeleted++;
    } else {
      summary.skippedMoving++;
    }
  }

  // ============ 3) mergeUndercutPairs ============
  const tripsRaw = await q(
    `SELECT id, deviceId, userId, sessionIds, sessionCount, startTime, endTime, spanStart, spanEnd
       FROM Trip WHERE deletedAt IS NULL ORDER BY spanStart ASC`
  );
  interface TripRow {
    id: string;
    deviceId: string;
    userId: string | null;
    ids: string[];
    startTime: number;
    endTime: number | null;
    spanStart: number;
    spanEnd: number | null;
  }
  const trips: TripRow[] = [];
  for (const r of tripsRaw) {
    const spanStart = Date.parse(String(r.spanStart));
    const spanEnd = r.spanEnd == null ? null : Date.parse(String(r.spanEnd));
    const startTime = Date.parse(String(r.startTime));
    const endTime = r.endTime == null ? null : Date.parse(String(r.endTime));
    if (!Number.isFinite(spanStart) || !Number.isFinite(startTime)) continue;
    trips.push({
      id: String(r.id),
      deviceId: String(r.deviceId),
      userId: r.userId == null ? null : String(r.userId),
      ids: parseIds(r.sessionIds),
      startTime,
      endTime,
      spanStart,
      spanEnd,
    });
  }
  const pairs: Array<{ a: TripRow; b: TripRow; gapMs: number }> = [];
  for (const a of trips) {
    for (const b of trips) {
      if (a.id === b.id || a.deviceId !== b.deviceId) continue;
      if (a.spanEnd == null || b.spanStart < a.spanEnd) continue; // только непересекающиеся
      const gapMs = b.spanStart - a.spanEnd;
      if (gapMs < MERGE_MAX_MS) pairs.push({ a, b, gapMs });
    }
  }
  pairs.sort((x, y) => (y.a.spanEnd ?? y.a.spanStart) - (x.a.spanEnd ?? x.a.spanStart)); // СВЕЖИЕ пары первыми — боль юзера сейчас
  for (const p of pairs.slice(0, MERGE_LIMIT)) {
    const { a, b } = p;
    // проверка по СЫРЫМ сессиям (span мог быть растянут хвостами) — как воркер
    let realGap = p.gapMs;
    if (a.ids.length > 0 && b.ids.length > 0) {
      const aEnd = await sessionBound(a.ids, "MAX(endTime)");
      const bStart = await sessionBound(b.ids, "MIN(startTime)");
      if (aEnd != null && bStart != null) {
        realGap = bStart - aEnd;
        if (realGap >= MERGE_MAX_MS) {
          log({ t: "heal:merge:skip", tripA: a.id, tripB: b.id, spanGapMs: p.gapMs, sessionGapMs: realGap, reason: "session-gap >= merge window" });
          summary.mergeSkipped++;
          continue;
        }
      }
    }
    const union = [...new Set([...a.ids, ...b.ids])];
    const spanStartIso = iso(Math.min(a.spanStart, b.spanStart));
    const spanEndCandidates = [a.spanEnd, b.spanEnd].filter((v): v is number => v != null);
    const spanEndIso = spanEndCandidates.length > 0 ? iso(Math.max(...spanEndCandidates)) : iso(b.spanStart);
    const startTimeIso = iso(Math.min(a.startTime, b.startTime));
    const endCandidates = [a.endTime, b.endTime].filter((v): v is number => v != null);
    const endTimeIso = endCandidates.length > 0 ? iso(Math.max(...endCandidates)) : null;
    const userId = a.userId ?? b.userId ?? null;
    log({ t: "heal:merge", tripA: a.id, tripB: b.id, gapMs: realGap, sessions: union.length, dryRun: DRY_RUN });
    if (!DRY_RUN) {
      await qBatch([
        {
          sql: `UPDATE Trip SET startTime = ?, endTime = ?, spanStart = ?, spanEnd = ?,
                  sessionIds = ?, sessionCount = ?, userId = ?,
                  statsComputedAt = NULL, activeDurationSec = NULL, movingTimeSec = NULL,
                  idleTimeSec = NULL, gapTimeSec = NULL, internalStopTimeSec = NULL,
                  distanceM = NULL, pointCountActual = NULL, maxSpeedMs = NULL, ecoScore = NULL,
                  planDistanceM = NULL, planDurationSec = NULL, planComparable = NULL,
                  planCoverage = NULL, routingLegCount = NULL, updatedAt = ?
                WHERE id = ?`,
          params: [startTimeIso, endTimeIso, spanStartIso, spanEndIso, JSON.stringify(union), union.length, userId, nowIso, a.id],
        },
        { sql: "UPDATE Session SET tripId = ?, updatedAt = ? WHERE tripId = ?", params: [a.id, nowIso, b.id] },
        { sql: "DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')", params: [b.id] },
        {
          sql: `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
                 SELECT ?, ?, 'pending', 0, 0, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`,
          params: [crypto.randomUUID(), a.id, nowIso, nowIso, a.id],
        },
        {
          sql: `UPDATE Trip SET trafficJobId = COALESCE(
                    (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
            WHERE id = ? AND trafficJobId IS NULL`,
          params: [a.id, a.id],
        },
        { sql: "DELETE FROM Trip WHERE id = ?", params: [b.id] },
      ]);
      // v2: сброс tsw-KV-ключа keeper'а (ttl 60 c платформы) — иначе прогрев
      // метрик слитой поездки ждёт до 6 ч (кейс cf7c71d4 01.10: ключ с
      // утреннего прогрева жив до ~22:00 при statsComputedAt=NULL с 16:39)
      try {
        await gwCall("/kvstore/put", { key: "fm:tsw:" + a.id, value: "heal-merge-reset", ttlSec: 1 });
        log({ t: "heal:tswReset", tripId: a.id, dryRun: DRY_RUN });
      } catch {
        /* сброс не удался — прогрев доберёт по истечении 6ч TTL */
      }
    }
    summary.merged++;
  }

  // ============ 4) deviceSilentAudit ============
  try {
    const devs = await q(
      `SELECT deviceId, MAX(endTime) AS lastEnd FROM Session
        WHERE deletedAt IS NULL AND startTime > ? GROUP BY deviceId`,
      [iso(now - 7 * 86_400_000)]
    );
    const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false });
    const localHour = Number(hourFmt.format(new Date(now)));
    for (const d of devs) {
      const dev = String(d.deviceId);
      if (/^(proxy-|diag-)|-test$|e2e/i.test(dev)) continue; // тестовые девайсы не будоражим
      const lastEnd = Date.parse(String(d.lastEnd));
      if (!Number.isFinite(lastEnd)) continue;
      const silentMs = now - lastEnd;
      const inBand = (silentMs >= 3 * 3_600_000 && silentMs < 9 * 3_600_000) || (silentMs >= 21 * 3_600_000 && silentMs < 27 * 3_600_000);
      if (!inBand) continue;
      if (!(localHour >= 7 && localHour <= 23)) continue; // ночью молчание — норма
      const seen = await q(
        `SELECT 1 AS x FROM AuditLog WHERE action = 'device.silent' AND targetId = ? AND createdAt > ? LIMIT 1`,
        [dev, iso(now - 20 * 3_600_000)]
      );
      if (seen.length > 0) continue;
      const meta = JSON.stringify({
        silentHours: Math.round(silentMs / 3_600_000),
        lastPointAt: iso(lastEnd),
        hint: "нет данных с устройства — приложение на телефоне закрыто/убито ОС; поездки НЕ записываются (проверить приложение)",
      });
      log({ t: "heal:deviceSilent", deviceId: dev, silentHours: Math.round(silentMs / 3_600_000), lastPointAt: iso(lastEnd), dryRun: DRY_RUN });
      if (!DRY_RUN) {
        await qBatch([
          {
            sql: `INSERT INTO AuditLog (id, userId, action, targetId, targetType, actorType, actorId, metadata, sessionId, createdAt)
                   VALUES (?, NULL, 'device.silent', ?, 'Device', 'system', 'trip-heal-gha', ?, NULL, ?)`,
            params: [crypto.randomUUID(), dev, meta, nowIso],
          },
        ]);
      }
      summary.audits++;
    }
  } catch (e) {
    summary.errors.push(`deviceSilent: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ============ 5) warmStats (CR-H 2026-10-03) ============
  // Замена мёртвого tsw-прогрева воркера v3 (прод): поездки со
  // statsComputedAt IS NULL (созданные adopt-движком / слитые merge)
  // греются самим приложением — GET /api/trips/batch?ids=… с Bearer
  // apiKey владельца (persist метрик — в том же запросе, методология
  // приложения 1:1). Спим 10 минут после spanEnd — состав устаканился.
  try {
    const cold = await q(
      `SELECT id, userId FROM Trip
        WHERE deletedAt IS NULL AND statsComputedAt IS NULL AND status = 'completed'
          AND spanEnd IS NOT NULL AND spanEnd < ?
        ORDER BY spanStart ASC LIMIT ${WARM_LIMIT}`,
      [iso(now - 10 * 60_000)]
    );
    if (cold.length > 0) {
      const byUser = new Map<string, string[]>();
      for (const c of cold) {
        const uid = c.userId == null ? "" : String(c.userId);
        const arr = byUser.get(uid) ?? [];
        arr.push(String(c.id));
        byUser.set(uid, arr);
      }
      for (const [uid, ids] of byUser) {
        if (DRY_RUN) {
          log({ t: "heal:warm", trips: ids.length, dryRun: true });
          continue;
        }
        let apiKey: string | null = null;
        if (uid !== "") {
          const u = (await q("SELECT apiKey FROM User WHERE id = ?", [uid]))[0];
          apiKey = u?.apiKey == null ? null : String(u.apiKey);
        }
        if (!apiKey) {
          log({ t: "heal:warm:skip", reason: "no apiKey", userId: uid.slice(0, 8) });
          continue;
        }
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), 45_000);
        try {
          const res = await fetch(`${APP_ORIGIN}/api/trips/batch?ids=${encodeURIComponent(ids.join(","))}`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: ctrl.signal,
          });
          log({ t: "heal:warm", trips: ids.length, userId: uid.slice(0, 8), status: res.status });
          if (res.ok) summary.warmed += ids.length;
          else summary.errors.push(`warm HTTP ${res.status} (user ${uid.slice(0, 8)})`);
        } catch (e) {
          summary.errors.push(`warm: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(tm);
        }
      }
    }
  } catch (e) {
    summary.errors.push(`warmStats: ${e instanceof Error ? e.message : String(e)}`);
  }
} catch (e) {
  summary.errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
}

log({ t: "heal:summary", ...summary, mergeWindowSec: MERGE_MAX_SEC, tookMs: Date.now() - t0 });
if (summary.errors.length > 0) process.exit(1);
