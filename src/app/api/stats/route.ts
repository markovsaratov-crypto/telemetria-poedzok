// GET /api/stats — агрегированная статистика для dashboard (§3.x overview).
// Cookie или Bearer API_KEY.
//
// v2.18.0: (а) perDay УДАЛЁН — 0 потребителей (тип в hooks.ts и всё), 7 фильтр-
// проходов на каждый запрос (включая 30-с poll) впустую + датные метки
// показывали UTC-дату сдвинутого дня (для tz≠UTC — на день раньше);
// (б) todaySessions влиты в общий Promise.all (был отдельный раундтрип);
// (в) URL парсится один раз.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionScopeWhere } from "@/lib/scope";
import { json, jsonWithEtag, computeWeakEtag } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { readIngestTrace, readIngestRaw } from "@/lib/ingest-trace"; // DIAG-1: трассировка; v2.10.8: сырой дамп по ?ingestRaw=1
import { tripsEnabled } from "@/lib/trip-grouping"; // v2.26.0 (ТЗ §10): счётчики поездок
import { libsql } from "@/lib/db";
import type { DataScope } from "@/lib/scope";
import { getTtlCache } from "@/lib/ttl-cache"; // v2.38.2 · F46: TTL-кэш тяжёлых агрегатов
import { trackLatency } from "@/lib/latency"; // v2.38.2 · F43: p95 дашбордных роутов
// v2.39.0 (§A1/§B2): rollup-агрегаты и edge-KV тяжёлых SELECT
import {
  readRollupSummary,
  rollupIsUsable,
  sessionScopeCounters,
  healRollupInBackground,
} from "@/lib/stats-rollup";
import { edgeKvQuery } from "@/lib/edge-gateway";

// v2.38.2 · F46: короткий TTL-кэш (60 с) ответа дашборда. Каждый вызов без кэша —
// COUNT(*) по ВСЕМ GpsPoint живых сессий + heatmap до 5000 строк + 7 параллельных
// счётчиков: на D1 это rows_read по всей таблице точек на каждый poll (поллинг
// 60 с × 1440 = десятки млн rows_read/день — квота уже выгорала однажды).
// Ключ = скоуп + «сегодня»-корзина клиента + параметры запроса (изоляция
// per-user: own:{userId} — чужие данные не пересекаются) — паттерн батч-роутов
// (getTtlCache на globalThis, «stats-dashboard»).
// Инвалидация: только TTL (60 с ≤ интервал поллинга — единственное окно одного
// зрителя всегда ревалидируется, а всплески рефетчей/несколько вкладок-устройств
// поглощаются кэшем) + смена «сегодня»-корзины (полночь клиента) — счётчики дня
// переворачиваются мгновенно, не через TTL. Рестарт/мультиинстанс — кэш холодный
// (in-memory, как у батч-роутов). ingestTrace отдаётся с лагом ≤ 60 с —
// приемлемо для дебаг-канала.
// v2.39.0 (§A2): значение кэша теперь {payload, etag} — слабый ETag считается
// ОДИН РАЗ при заполнении кэша (вход: ключ кэша + сериализованный JSON), ответ
// отдаётся через jsonWithEtag: If-None-Match-совпадение → 304 (пустое тело,
// ETag + Cache-Control сохраняются).
interface StatsCacheEntry {
  payload: Record<string, unknown>;
  etag: string;
}
const STATS_CACHE = getTtlCache<StatsCacheEntry>("stats-dashboard", 60_000, 64);

// v2.39.0 (§B2): версия схемы KV-ключей edge-кэша (инфраструктурная: смена
// формата ответа тяжёлых запросов → bump, старые KV-записи игнорируются).
const EDGE_CACHE_VERSION = 1;

// v2.26.0: число поездок в зоне видимости (опционально от fromMs — «сегодня»)
async function countTripsForScope(scope: DataScope, from?: Date): Promise<number> {
  const cond: string[] = ["deletedAt IS NULL"];
  const args: unknown[] = [];
  if (scope.mode === "own") {
    cond.push("userId = ?");
    args.push(scope.userId);
  } else if (scope.mode === "unclaimed") {
    cond.push("userId IS NULL");
  }
  if (from) {
    cond.push("spanStart >= ?");
    args.push(from.toISOString());
  }
  const res = await libsql.execute({
    sql: `SELECT COUNT(*) AS c FROM Trip WHERE ${cond.join(" AND ")}`,
    args: args as never[],
  });
  return Number((res.rows[0] as Record<string, unknown>).c);
}

// v2.29.0 (MI-4 кодревью): счётчики заданий маршрутизации — в зоне видимости
// запрашивающего (раньше role=user видел ГЛОБАЛЬНЫЕ числа всех пользователей;
// v2.26: задание принадлежит сессии ИЛИ поездке — скоуп по обоим владельцам).
async function countTrafficJobsForScope(scope: DataScope, status: string | null): Promise<number> {
  const cond: string[] = ["1=1"];
  const args: unknown[] = [];
  if (scope.mode === "own") {
    cond.push("(s.userId = ? OR t.userId = ?)");
    args.push(scope.userId, scope.userId);
  } else if (scope.mode === "unclaimed") {
    cond.push("(s.userId IS NULL OR t.userId IS NULL)");
  }
  if (status) {
    cond.push("tj.status = ?");
    args.push(status);
  }
  const res = await libsql.execute({
    sql: `SELECT COUNT(*) AS c FROM TrafficJob tj
          LEFT JOIN Session s ON tj.sessionId = s.id
          LEFT JOIN Trip t ON tj.tripId = t.id
          WHERE ${cond.join(" AND ")}`,
    args: args as never[],
  });
  return Number((res.rows[0] as Record<string, unknown>).c);
}

// v2.29.0 (MI-4): маршруты — в зоне видимости запрашивающего
// (у типизированной обёртки db.route.count нет where-аргумента — raw SQL).
async function countRoutesForScope(scope: DataScope): Promise<number> {
  const cond: string[] = ["1=1"];
  const args: unknown[] = [];
  if (scope.mode === "own") {
    cond.push("userId = ?");
    args.push(scope.userId);
  } else if (scope.mode === "unclaimed") {
    cond.push("userId IS NULL");
  }
  const res = await libsql.execute({
    sql: `SELECT COUNT(*) AS c FROM Route WHERE ${cond.join(" AND ")}`,
    args: args as never[],
  });
  return Number((res.rows[0] as Record<string, unknown>).c);
}

// v2.39.0 (§A1/§B2): каскад тяжёлых счётчиков дашборда — rollup → edge-KV →
// прежний прямой путь v2.38.2. ЛЮБОЙ сбой верхних слоёв тихо деградирует вниз;
// дашборд не имеет права упасть (главное требование задачи).
//   1. StatsRollup (§A1): SUM(points) O(дней) вместо COUNT(*) по GpsPoint.
//      Честность гарантируется сверкой с лёгким счётчиком маленькой таблицы
//      Session: SUM(rollup.sessions)==COUNT(Session) И rollup свежее
//      MAX(Session.updatedAt). При расхождении — фоновый heal + fallback.
//   2. edgeKvQuery (§B2): тот же тяжёлый COUNT, но 30 с в KV гейтвея
//      (квота D1 не тратится на промахах повторов).
//   3. Прежний db.gpsPoint.count (v2.38.2) — последний эшелон.
async function computeTotalPoints(scope: DataScope, scopeKey: string, dayBucket: number): Promise<number> {
  // — 1. rollup —
  try {
    const [summary, sessionCounters] = await Promise.all([
      readRollupSummary(scope),
      sessionScopeCounters(scope),
    ]);
    if (summary != null && sessionCounters != null) {
      if (rollupIsUsable(summary, sessionCounters.count, sessionCounters.maxUpdatedAt)) {
        return summary.points;
      }
      // неполон/несвеж — фоновое самолечение (кулдаун 60с внутри), ответ прежним путём
      healRollupInBackground(scope);
    }
  } catch {
    // rollup-ветка обязана молчать (внутри уже warn-лог), дашборд не падает
  }
  // — 2. edge-KV (только SELECT; гейтвей до обновления ответит 404 → kv:"error") —
  try {
    const res = await edgeKvQuery(
      `dash:${scopeKey}:${dayBucket}:points:v${EDGE_CACHE_VERSION}`,
      `SELECT COUNT(*) AS c FROM GpsPoint WHERE sessionId IN (SELECT id FROM Session WHERE deletedAt IS NULL${
        scope.mode === "own" ? " AND userId = ?" : scope.mode === "unclaimed" ? " AND userId IS NULL" : ""
      })`,
      scope.mode === "own" ? [scope.userId] : [],
      30
    );
    const c = Number((res.rows[0] as Record<string, unknown> | undefined)?.c);
    if (res.kv !== "error" && Number.isFinite(c)) return c;
  } catch {
    // edge-KV и прямой путь не ответили — идём в прежний путь ниже
  }
  // — 3. прежний путь v2.38.2 —
  return db.gpsPoint.count({ where: { session: { deletedAt: null, ...sessionScopeWhere(scope) } } });
}

// v2.39.0 (§A1): heatmap за 12 недель — из rollup O(дней) (при полноте) — по дневным
// строкам {day → startTime+pointCount}; fallback — прежний findMany (до 5000 строк).
// Поле НИГДЕ на фронте не потребляется (0 потребителей, проверено v2.18.0
// и повторно v2.39.0) — формат {startTime, pointCount} сохранён для обратной
// совместимости внешних потребителей: одна «сессия» = один день rollup.
async function computeHeatmap(
  scope: DataScope,
  scopeKey: string,
  dayBucket: number,
  twelveWeeksAgo: Date
): Promise<Array<{ startTime: string; pointCount: number }>> {
  // — 1. rollup (достаточно полноты — те же критерии, что totalPoints) —
  try {
    const [summary, sessionCounters] = await Promise.all([
      readRollupSummary(scope),
      sessionScopeCounters(scope),
    ]);
    if (summary != null && sessionCounters != null) {
      if (rollupIsUsable(summary, sessionCounters.count, sessionCounters.maxUpdatedAt)) {
        // строки дней: локальная полночь дня в TELEMAT → ISO (дата видна той же,
        // что у прежних сессий этого дня)
        return summary.recentDays.map((d) => ({
          startTime: `${d.day}T00:00:00.000Z`,
          pointCount: d.points,
        }));
      }
      healRollupInBackground(scope);
    }
  } catch {
    // молча: ниже edge-KV и прежний путь
  }
  // — 2. edge-KV прежнего запроса —
  try {
    const sc =
      scope.mode === "own"
        ? { clause: " AND userId = ?", args: [scope.userId] as unknown[] }
        : scope.mode === "unclaimed"
          ? { clause: " AND userId IS NULL", args: [] as unknown[] }
          : { clause: "", args: [] as unknown[] };
    const res = await edgeKvQuery(
      `dash:${scopeKey}:${dayBucket}:heatmap:v${EDGE_CACHE_VERSION}`,
      `SELECT startTime, pointCount FROM Session WHERE deletedAt IS NULL AND startTime >= ?${sc.clause} ORDER BY startTime ASC LIMIT 5000`,
      [twelveWeeksAgo.toISOString(), ...sc.args],
      30
    );
    if (res.kv !== "error") {
      return (res.rows as Record<string, unknown>[]).map((r) => ({
        startTime: String(r.startTime ?? ""),
        pointCount: Number(r.pointCount ?? 0),
      }));
    }
  } catch {
    // ниже прежний путь
  }
  // — 3. прежний путь v2.38.2 (включая лимит АУДИТ C-7) —
  const rows = await db.session.findMany({
    where: { startTime: { gte: twelveWeeksAgo }, deletedAt: null, ...sessionScopeWhere(scope) },
    select: { startTime: true, pointCount: true },
    orderBy: { startTime: "asc" },
    take: 5000,
  });
  return rows.map((s) => ({ startTime: String(s.startTime ?? ""), pointCount: Number(s.pointCount ?? 0) }));
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // v2.23.0: изоляция данных — все агрегаты дашборда в зоне видимости запрашивающего
    const scope = dataScopeFor(auth);
    const scopeW = sessionScopeWhere(scope);

    const url = new URL(request.url);

    // v2.38.2 · F46: разбор параметров ДО агрегатов — по ним строится ключ кэша.
    // v2.16.0 (B7): «сегодня» — в часовом поясе КЛИЕНТА (?tzOffsetMin, как
    // Date#getTimezoneOffset; по умолчанию 0 = UTC). Раньше полночь бралась в
    // СЕРВЕРНОМ поясе — на Render UTC «сегодня» начиналось в 03:00 МСК.
    const tzRaw = Number(url.searchParams.get("tzOffsetMin"));
    const tzOffsetMin = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 15 * 60 ? Math.round(tzRaw) : 0;
    const tzMs = tzOffsetMin * 60_000;
    const todayStartMs = Math.floor((Date.now() - tzMs) / 86_400_000) * 86_400_000 + tzMs;

    // v2.10.8: полный дамп последнего нераспознанного батча — ТОЛЬКО по
    // ?ingestRaw=1: до 64 КБ в теле ответа, не таскаем его в каждом запросе.
    // v2.23.0: сырой дамп чужих батчей — только владелец/админ
    const wantRaw = url.searchParams.get("ingestRaw") === "1" && scope.mode !== "own";

    // v2.38.2 · F46: ключ = скоуп + «сегодня»-корзина клиента (переворот в
    // полночь tz) + параметры. Попадание — готовый ответ без агрегатов.
    // v2.39.0 (§A2): кэш хранит {payload, etag}; 304 отдаётся прямо из кэша.
    const dayBucket = Math.floor((Date.now() - tzMs) / 86_400_000);
    const scopeKey = scope.mode === "own" ? `own:${scope.userId}` : scope.mode === "unclaimed" ? "unclaimed" : "all";
    const cacheKey = `${scopeKey}|day:${dayBucket}|tz:${tzOffsetMin}|raw:${wantRaw ? 1 : 0}`;
    const cached = STATS_CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request); // v2.38.2 · F43: кэшированный ответ тоже в p95
      return jsonWithEtag(cached.payload, cached.etag, request, 200, {
        "X-Request-Id": requestId,
        "X-Cache": "ttl",
      });
    }

    // All-time stats
    // v2.12.0 (D-1): totalPoints — только точки ЖИВЫХ сессий (deletedAt IS NULL).
    // Раньше считались все строки GpsPoint, включая осиротевшие точки
    // софт-делетнутых сессий → «GPS-точек (всего)» в админке расходилось
    // с суммой по поездкам в других разделах.
    // v2.26.0 (ТЗ §10): + счётчики ПОЕЗДОК (tripsCount) — «поездки» = Trip;
    // totalSessions/todaySessions сохраняются как «записи» (обратная совместимость).
    // v2.29.0 (MI-4): totalRoutes/TrafficJob — тоже в скоупе запрашивающего.
    // v2.39.0 (§A1): totalPoints/heatmap ВЫНЕСЕНЫ из Promise.all — каскад
    // rollup → edge-KV → прямой (см. computeTotalPoints/computeHeatmap); лёгкие
    // счётчики маленьких таблиц (Session/Trip/Route/TrafficJob) не рефакторятся.
    const [totalSessions, totalRoutes, totalTrafficJobs, deadJobs, pendingJobs, totalTrips] = await Promise.all([
      db.session.count({ where: { deletedAt: null, ...scopeW } }),
      countRoutesForScope(scope),
      countTrafficJobsForScope(scope, null),
      countTrafficJobsForScope(scope, "dead"),
      countTrafficJobsForScope(scope, "pending"),
      tripsEnabled() ? countTripsForScope(scope) : Promise.resolve(0),
    ]);
    const totalPoints = await computeTotalPoints(scope, scopeKey, dayBucket);

    // Today
    // v2.16.0 (I4): независимые запросы — параллельно (было 4
    // последовательных HTTPS-раундтрипа к Turso); v2.18.0: + todaySessions (5-й)
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84); // v2.16.0 (V4): имя = суть (12 недель, не «30 дней»)
    // v2.29.0 (MI-3 кодревью): recentSessions (findMany до 5000 строк) удалён —
    // выбирался на каждый 30-сек poll и НИГДЕ не использовался (0 потребителей).
    const [todaySessions, totalBytesResult, ingestTrace, todayTrips] = await Promise.all([
      db.session.count({
        where: { startTime: { gte: new Date(todayStartMs) }, deletedAt: null, ...scopeW },
      }),
      // v2.18.0: where: {deletedAt: null} — лишний (aggregate SQL уже фильтрует живые)
      db.session.aggregate({
        _sum: { payloadBytes: true },
        ...(scope.mode === "own" ? { where: { userId: scope.userId } } : scope.mode === "unclaimed" ? { where: { userId: null } } : {}),
      }),
      // v2.23.0: трейс инжеста — только владельцу/админу (это дебаг-канал
      // владельца: deviceId и сырое тело батчей его телефона)
      scope.mode === "own"
        ? Promise.resolve({ last: null, recent: [], updatedAt: null })
        : readIngestTrace().catch(() => ({ last: null, recent: [], updatedAt: null })),
      // v2.26.0 (ТЗ §10): «сегодня» = поездки со spanStart в клиентском дне
      // (включая recording — «Сегодня» видит идущую поездку), scope-фильтр — тот же
      tripsEnabled()
        ? countTripsForScope(scope, new Date(todayStartMs))
        : Promise.resolve(0),
    ]);
    // v2.39.0 (§A1/§B2): heatmap — каскадом rollup → edge-KV → прежний findMany
    // (до 84 строк дней из rollup вместо до 5000 сессий)
    const heatmapSessions = await computeHeatmap(scope, scopeKey, dayBucket, twelveWeeksAgo);

    // v2.10.8: полный дамп последнего нераспознанного батча — ТОЛЬКО по
    // ?ingestRaw=1 (см. разбор параметров выше — v2.38.2 · F46)
    const ingestRaw = wantRaw
      ? await readIngestRaw().catch(() => null)
      : null;

    const payload: Record<string, unknown> = {
        totalSessions,
        totalPoints,
        totalRoutes,
        totalTrafficJobs,
        deadJobs,
        pendingJobs,
        todaySessions,
        // v2.26.0 (ТЗ §10): счётчики поездок; sessionsCount-поля сохранены
        // (обратная совместимость потребителей «записей»)
        totalTrips,
        todayTrips,
        totalPayloadBytes: totalBytesResult._sum.payloadBytes || 0,
        // v2.39.0 (§A1): при rollup-пути — дневные агрегаты (до 84 строк),
        // при fallback — прежние посессионные; формат идентичен
        heatmapSessions,
        // Capacity info (блокер №1 — отображение в UI)
        capacity: {
          targetLoadRpm: env().TARGET_LOAD_RPM,
          rateLimitMaxIngest: env().RATE_LIMIT_MAX_INGEST,
          headroom: env().RATE_LIMIT_MAX_INGEST - env().TARGET_LOAD_RPM,
        },
        version: env().APP_VERSION,
        // DIAG-1: {last, recent (≤20), updatedAt} — попытки инжеста всех исходов
        ingestTrace,
        // v2.10.8: {at, deviceId, outcome, bytes, truncated, body} — только при ?ingestRaw=1
        ...(wantRaw ? { ingestRaw } : {}),
      };

    // v2.39.0 (§A2): ETag — считается ОДИН раз при заполнении TTL-кэша
    // (вход: ключ кэша (скоп+корзина+параметры) + сериализованный JSON);
    // кэш хранит {payload, etag} — повторные ответы и 304 из кэша бесплатны.
    const etag = await computeWeakEtag(`${cacheKey}|${JSON.stringify(payload)}`);
    STATS_CACHE.set(cacheKey, { payload, etag }); // v2.38.2 · F46: revalidate-on-miss — следующий запрос в окне уже из кэша
    trackLatency(request); // v2.38.2 · F43: свежевычисленный ответ дашборда в p95

    return jsonWithEtag(payload, etag, request, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
