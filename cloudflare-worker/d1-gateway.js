// d1-gateway — аутентифицированный SQL-шлюз над Cloudflare D1.
// Деплой: Workers API (module syntax). БД привязана биндингом DB.
// Auth: заголовок X-Gateway-Secret (секрет GATEWAY_SECRET в env воркера).
//
// Эндпоинты:
//   GET  /health                          → {ok, gateway:"d1", db:"bound"}
//   POST /query   {sql, params?}          → {rows, rowsAffected, meta}
//   POST /batch   {statements:[{sql,params}]} → АТОМАРНО → [{rows, rowsAffected, meta}, ...]
//   POST /ingest  (body Sensor Logger)    → §B1: см. ingest-port.js (своя auth)
//   POST /kvcache {key, sql, params, ttlSec} → §B2: SELECT через KV-кэш
//   POST /kvcache/invalidate {prefix}     → §B2: сброс кэша по префиксу
//   POST /api/ingest                      → §B1 v2.40.0: алиас /ingest (host-only switch)
//   POST /admin/turso-migrate {steps?,reset?} → §T-DELTA: шаги мигратора Turso-дельты
//   GET  /admin/turso-migrate/status      → §T-DELTA: состояние миграции (KV)
//   GET  /admin/cron-status               → §B5: последние запуски всех cron-джоб
//   scheduled (Cron Triggers)             → §B5: планировщик вместо cron-сервисов Render
//
// Формат ответа повторяет @libsql/client ResultSet (rows как объекты,
// rowsAffected), чтобы адаптер на стороне приложения оставался тонким.
//
// v2.37.0 (миграция Turso → D1): воркер создан, потому что D1 REST API
// требует отдельного разрешения у токена; биндинг воркера получает доступ
// к D1 через Workers-рантайм без D1-API-прав у токена деплоя.
//
// v2.38.1 (ревью F1, hardening): секрет шлюза был скоммичен в публичный репо
// (.env.production.local, коммит 25bd1bd) — «один секрет» больше не считается
// достаточной защитой, добавлены три слоя (ротация секрета — владелец, см.
// docs/SECURITY-ROTATION.md):
//   1) ВАЙТЛИСТ ОПЕРАЦИЙ: только SELECT/INSERT/UPDATE/DELETE по известным
//      таблицам (prisma/schema.prisma + рантайм-таблица _AlertState) + два
//      идемпотентных исключения (PRAGMA page_count/page_size, CREATE TABLE IF
//      NOT EXISTS _AlertState). DROP/ALTER/ATTACH/VACUUM/PRAGMA(прочие)/CTE и
//      любые неизвестные таблицы (вкл. sqlite_*) → 403 ДО исполнения;
//   2) ЛИМИТ ТЕЛА: стрим с капом (дефолт 2 МБ) → 413 — и по content-length,
//      и по фактическим байтам (chunked без заголовка не проходит);
//   3) PER-IP RATE-LIMIT в памяти изолейта (дефолт 3000/мин → 429;
//      env-оверрайд GATEWAY_RATE_LIMIT_MAX). Дефолт НЕ 60/мин из рецепта
//      ревью осознанно: единственный легитимный вызывающий — приложение на
//      Render, один HTTP-запрос API порождает несколько SQL-вызовов (фан-аут
//      инжеста/статов), 60/мин душил бы прод; 3000/мин = 50 rps ≈ 10×
//      пикового легитимного трафика, останавливает runaway-циклы и
//      скан-штормы с украденным секретом. Проверяется ПОСЛЕ auth — без
//      секрета нельзя бесплатно 429-нуть легитимного вызывающего.
//
// v2.38.2 (ревью F33, minor): (а) секрет сравнивается по SHA-256-дайджестам
//      без раннего выхода по длине (раньше тайминг ответа 401 выдавал ДЛИНУ
//      секрета); (б) опциональный READ-ONLY режим (env GATEWAY_READ_ONLY) —
//      только SELECT и read-only PRAGMA, см. isReadOnly().
//
// v2.39.1 (§B1 + §B2, docs/OPTIMIZATION-PROPOSAL.md): 
//   §B1 — монтаж edge-инжеста: /ingest проксирует в handleEdgeIngest из
//      ./ingest-port.js (портативный ESM-модуль, паритет ответов с
//      /api/ingest). Своя авторизация: INGEST_TOKEN (Bearer или ?token=)
//      ИЛИ X-Gateway-Secret — поэтому ветка стоит ДО общего гейта секрета.
//      it_/apiKey-канал на edge сознательно не поддержан (личные
//      устройства — через Render, см. шапку ingest-port.js).
//   §B2 — KV-кэш тяжёлых SELECT (cache-aside на стороне воркера, биндинг KV
//      типа kv_namespace, ОБРАТНАЯ СОВМЕСТИМОСТЬ: биндинга нет → прямой
//      запрос, kv:"passthrough" — приложение без KV не меняет поведение):
//      только SELECT по таблицам вайтлиста (та же validateStatement в
//      read-only режиме), значение — JSON {rows} с капом 512 КБ, TTL
//      клиентский ttlSec (платформенный минимум KV 60с — округляем вверх,
//      задокументировано в edge-gateway.ts), инвалидация — list по префиксу
//      с пагинацией (кап 100 страниц = 100k ключей, полный сброс «dash:»).

import { handleEdgeIngest } from "./ingest-port.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// ——— v2.38.1 (ревью F1): вайтлист операций ———
// Таблицы prisma/schema.prisma (User, Session, Trip, GpsPoint, Route,
// RouteCache, TrafficJob, AuditLog, ExportJob, BackupJob, Setting,
// IngestMessage) + рантайм-таблица алертов _AlertState (alerts.ts и
// restore-core.ts). Всё, чего нет в списке (включая sqlite_*), → 403.
const ALLOWED_TABLES = new Set(
  [
    "User",
    "Session",
    "Trip",
    "GpsPoint",
    "Route",
    "RouteCache",
    "TrafficJob",
    "AuditLog",
    "ExportJob",
    "BackupJob",
    "Setting",
    "IngestMessage",
    "_AlertState",
    // v2.39.1 (§A1): дневные агрегаты — /query читает/пишет её ПОСЛЕ деплоя
    // v2.39.0-приложения; /ingest-порт пишет независимо от вайтлиста
    // (стейтменты фиксированы), строка нужна для /query и create-index.
    "StatsRollup",
  ].map((t) => t.toLowerCase())
);

// Единственные исключения помимо DML (оба используются рантаймом приложения):
//  - PRAGMA page_count / PRAGMA page_size — read-only размер БД (alerts.ts,
//    правило db_size_growth; при отказе деградирует мягко — «PRAGMA недоступен»);
//  - CREATE TABLE IF NOT EXISTS _AlertState — идемпотентное самовосстановление
//    KV-таблицы алертов (alerts.ts + restore-core.ts). IF NOT EXISTS = no-op на
//    существующей таблице, существующие данные не трогает.
const PRAGMA_RE = /^PRAGMA\s+(page_count|page_size)\s*$/i;
const CREATE_ALERTSTATE_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?_AlertState"?\s*\(/i;
// v2.39.1 (§A1): ленивое самовосстановление StatsRollup-таблицы приложением
// (src/lib/stats-rollup.ts ensureStatsRollupTable — идемпотентный DDL, тот же
// паттерн что _AlertState: IF NOT EXISTS = no-op на существующей).
const CREATE_STATSROLLUP_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?StatsRollup"?\s*\(/i;
// v2.38.2 (ревью F50): идемпотентные индексы ensure-on-boot. Приложение
// создаёт Session_userId_startTime_idx лениво при первом списковом запросе
// (db.ts, fire-and-forget). IF NOT EXISTS = no-op на существующем индексе;
// допустимы только индексы на таблицах из ALLOWED_TABLES, имя индекса
// ограничено [A-Za-z0-9_] чтобы не протащить инъекцию в имя.
const CREATE_INDEX_RE =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z0-9_]+)"?\s+ON\s+"?([A-Za-z0-9_]+)"?\s*\(/i;

// ——— v2.38.1 (ревью F1): лимит тела и rate-limit ———
const MAX_BODY_BYTES_DEFAULT = 2 * 1024 * 1024; // 2 МБ
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_DEFAULT = 3000; // см. комментарий в шапке — почему не 60
const RATE_BUCKETS_MAX = 10000;

// ——— v2.39.1 (§B2): константы KV-кэша ———
// Тело /kvcache мало (sql+params): 64 КБ хватает с запасом, отдельный кап
// НЕ даёт кэш-эндпоинту съесть общий бюджет тела 2 МБ / гонки content-length.
const KVCACHE_MAX_BODY_BYTES = 64 * 1024;
// Ключи приложения — соглашение §B2: dash:{scope}:{day}:{cacheVersion};
// валидация имени отсекает пробел/управляющие/юникод-инъекции в KV-пространство.
const KVCACHE_KEY_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
// Значение — JSON {rows}: 512 КБ покрывает агрегаты дашборда (62 метрики ×
// 30 дней); большее — не кэшируем (отдаём как miss), чтобы изолят не душил
// память сериализацией чужих широких выборок.
const KVCACHE_VALUE_MAX_CHARS = 512 * 1024;
// TTL: 1..3600 с; платформенный минимум KV 60с — клиентские ttlSec<60
// округляются ВВЕРХ (клиент edge-gateway.ts осведомлён: «протухнет само»).
const KVCACHE_TTL_MIN_SEC = 1;
const KVCACHE_TTL_MAX_SEC = 3600;
const KV_PLATFORM_MIN_TTL_SEC = 60;
// Инвалидация: list пагинирован (1000 ключей/страница); 100 страниц — щит от
// бесконечного курсора, на реальном «dash:» десятки ключей.
const KVCACHE_INVALIDATE_MAX_PAGES = 100;
// Параметры bound-запроса: 100 с запасом поверх бюджета 90 ingest-порта.
const KVCACHE_PARAMS_MAX = 100;

// v2.38.2 (ревью F33): секрет сравнивается по ДАЙДЖЕСТАМ SHA-256 (как
// src/lib/token-check.ts в приложении — здесь inline, воркер отдельный файл):
// сначала хешируем ОБЕ стороны, потом сравниваем дайджесты XOR-аккумулятором
// по всей длине. Фиксированная длина (32 байта) убирает ранний выход по длине
// — старая версия возвращала false сразу при a.length !== b.length и
// утекала ДЛИНУ секрета по времени ответа 401. crypto.subtle доступен в
// Workers-рантайме из коробки.
async function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// ——— v2.38.1 (ревью F1): валидация стейтмента вайтлистом ———

// Убирает SQL-комментарии (-- и /* */) — глагол/таблицу нельзя спрятать в них.
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

// Имена таблиц после FROM/JOIN/INTO/UPDATE. «DO UPDATE SET» (хвост ON CONFLICT)
// вырезаем заранее — иначе за таблицу примется SET (alerts.ts: INSERT ... ON
// CONFLICT(key) DO UPDATE SET ...). Подзапрос «FROM (SELECT ...)» не матчится
// (за ключевым словом идёт «(», не идентификатор) — внутренние FROM ловятся
// тем же общим сканом.
const TABLE_TOKEN_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi;
function extractTableNames(sql) {
  const clean = stripSqlComments(sql).replace(/\bDO\s+UPDATE\s+SET\b/gi, " ");
  const names = new Set();
  let m;
  while ((m = TABLE_TOKEN_RE.exec(clean)) !== null) {
    names.add((m[1] ?? m[2] ?? m[3] ?? "").toLowerCase());
  }
  return names;
}

// v2.38.2 (ревью F33): опциональный READ-ONLY режим (env-биндинг воркера
// GATEWAY_READ_ONLY="true"/"1", читается из env ВЫЗОВА как
// GATEWAY_RATE_LIMIT_MAX — process.env в Workers-рантайме недоступен).
// Поверх вайтлиста операций: пропускаются ТОЛЬКО SELECT и два
// read-only PRAGMA (page_count/page_size) — INSERT/UPDATE/DELETE/CREATE
// отклоняются 403 ДО исполнения. Зачем: при компрометации единственного
// секрета зона поражения сужается с «вся БД» до «чтение»; полезно для
// страховочных реплик/отладочных инсталляций. Дефолт ВЫКЛ: приложение
// легитимно пишет через /query (execute() шлёт все DML — db-d1.ts),
// включение режима требует перевода приложения на read-only-потребление.
function isReadOnly(env) {
  return env.GATEWAY_READ_ONLY === "true" || env.GATEWAY_READ_ONLY === "1";
}

// Валидация ОДНОГО стейтмента. null = разрешено; строка = причина отказа (403).
function validateStatement(sql, readOnly) {
  // Мульти-стейтменты через «;» запрещены (D1 prepare их и так отверг бы —
  // валидируем ДО исполнения, включая попытку «SELECT 1; DROP TABLE Session»).
  const noTrailing = sql.replace(/;\s*$/, "");
  if (noTrailing.includes(";")) return "multiple statements are not allowed";

  const clean = stripSqlComments(noTrailing).trim();
  if (clean.length === 0) return "empty statement";

  const verbMatch = clean.match(/^([A-Za-z]+)/);
  if (!verbMatch) return "unrecognized statement";
  const verb = verbMatch[1].toUpperCase();

  // v2.38.2 (ревью F33): опциональный READ-ONLY режим — см. isReadOnly().
  if (readOnly) {
    if (verb === "SELECT") {
      const tables = extractTableNames(clean);
      if (tables.size > 0) {
        for (const t of tables) {
          if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
        }
      }
      return null;
    }
    if (verb === "PRAGMA") {
      return PRAGMA_RE.test(clean) ? null : "read-only mode: forbidden operation: PRAGMA";
    }
    return `read-only mode: forbidden operation: ${verb}`;
  }

  if (verb === "SELECT" || verb === "INSERT" || verb === "UPDATE" || verb === "DELETE") {
    const tables = extractTableNames(clean);
    if (tables.size === 0) {
      // SELECT без FROM (SELECT 1) безвреден; DML без таблицы — битый синтаксис
      return verb === "SELECT" ? null : "no table reference";
    }
    for (const t of tables) {
      if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
    }
    return null;
  }
  if (verb === "PRAGMA") {
    return PRAGMA_RE.test(clean) ? null : "forbidden operation: PRAGMA";
  }
  if (verb === "CREATE") {
    if (CREATE_ALERTSTATE_RE.test(clean)) return null;
    if (CREATE_STATSROLLUP_RE.test(clean)) return null;
    // v2.38.2 (F50): CREATE [UNIQUE] INDEX IF NOT EXISTS <idx> ON <allowed-table>
    const idxMatch = clean.match(CREATE_INDEX_RE);
    if (idxMatch && ALLOWED_TABLES.has(idxMatch[3].toLowerCase())) return null;
    return "forbidden operation: CREATE";
  }
  // DROP / ALTER / ATTACH / DETACH / VACUUM / EXPLAIN / BEGIN / COMMIT /
  // ROLLBACK / REPLACE / TRUNCATE / ANALYZE / REINDEX / SAVEPOINT / WITH (CTE)...
  return `forbidden operation: ${verb}`;
}

// ——— v2.38.1 (ревью F1): per-IP rate-limit (память изолейта воркера) ———
// CF-Connecting-IP ставит сам Cloudflare (доверенный). Окно 60 с, слiding.
const rateBuckets = new Map(); // ip → массив timestamp
function rateLimitExceeded(ip, limit, windowMs) {
  const now = Date.now();
  let ts = rateBuckets.get(ip);
  if (!ts) {
    if (rateBuckets.size > RATE_BUCKETS_MAX) {
      // грубая защита от роста карты: выметаем старейшую запись (insertion order)
      const oldest = rateBuckets.keys().next().value;
      if (oldest !== undefined) rateBuckets.delete(oldest);
    }
    ts = [];
    rateBuckets.set(ip, ts);
  }
  const fresh = [];
  for (const t of ts) {
    if (t > now - windowMs) fresh.push(t);
  }
  if (fresh.length >= limit) {
    rateBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return false;
}

// ——— v2.38.1 (ревью F1): чтение тела стримом с капом ———
// Стрим прерывается на превышении: chunked-запрос без content-length не может
// уложить память изолейта (раньше request.json() парсил всё подряд).
async function readBodyLimited(request, maxBytes) {
  const reader = request.body && typeof request.body.getReader === "function" ? request.body.getReader() : null;
  if (!reader) return { ok: false, status: 400, error: "empty body" };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      return { ok: false, status: 413, error: "payload too large", limitBytes: maxBytes };
    }
    chunks.push(value);
  }
  let byteLen = 0;
  for (const c of chunks) byteLen += c.byteLength;
  const merged = new Uint8Array(byteLen);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

// JSON не переносит BigInt — D1 может вернуть BigInt для INTEGER-колонок.
// Все наши значения < 2^53 (timestamp ~1.8e12), конвертация безопасна.
function bigintSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigintSafe(v);
    return out;
  }
  return value;
}

// SQLite хранит boolean как 0/1; D1-bind принимает boolean не во всех
// версиях — нормализуем на входе.
function normParam(p) {
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "bigint") return Number(p);
  return p;
}

// ——— v2.39.1 (§B2): KV-кэш SELECT (cache-aside) ———
// Контракт = src/lib/edge-gateway.ts (§B2): {key, sql, params, ttlSec} →
// {rows, meta, kv:"hit"|"miss"|"passthrough"}. Ошибки KV НЕ ломают ответ —
// деградация в прямой D1-запрос (приложение считает kv:"miss"/"error").
async function handleKvCache(env, body) {
  const { key, sql, params, ttlSec } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key (expected ^[A-Za-z0-9_:.-]{1,128}$)" }, 400);
  }
  if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
  if (!Array.isArray(params)) return json({ error: "params must be an array" }, 400);
  if (params.length > KVCACHE_PARAMS_MAX) {
    return json({ error: `too many params (max ${KVCACHE_PARAMS_MAX})` }, 400);
  }
  // Контракт клиента (edge-gateway.ts): ttlSec по умолчанию 30 — поле
  // опционально; не-число/вне диапазона → честная 400 (клиент фолбэчится).
  const ttl = Math.floor(Number(ttlSec ?? 30));
  if (!Number.isFinite(ttl) || ttl < KVCACHE_TTL_MIN_SEC || ttl > KVCACHE_TTL_MAX_SEC) {
    return json({ error: `ttlSec out of range (${KVCACHE_TTL_MIN_SEC}..${KVCACHE_TTL_MAX_SEC})` }, 400);
  }

  // Только SELECT (read-only ветка вайтлиста): в кэш не должно попадать ни
  // DML, ни новые глаголы — даже с валидным секретом вызова.
  const violation = validateStatement(sql, true);
  if (violation) return json({ error: "forbidden", reason: violation }, 403);

  // 1) Lookup. Отсутствие биндинга KV = «passthrough» (обратная
  // совместимость: воркер без KV не меняет контракт приложения).
  if (env.KV && typeof env.KV.get === "function") {
    try {
      const cached = await env.KV.get(key, "text");
      if (cached != null) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.rows)) {
            return json({
              rows: parsed.rows,
              meta: { kv: "hit", rowsRead: 0, durationMs: 0 },
              kv: "hit",
            });
          }
        } catch {
          // битая запись (частичная запись/эволюция формата) — выметаем
          await env.KV.delete(key).catch(() => {});
        }
      }
    } catch {
      // KV сбой (квота/сеть) — не мешаем: идём в D1 напрямую
    }
  }

  // 2) Прямое исполнение (miss-путь) — те же нормализации, что /query.
  let stmt = env.DB.prepare(sql);
  if (params.length > 0) stmt = stmt.bind(...params.map(normParam));
  const res = await stmt.all();
  const rows = bigintSafe(res.results ?? []);

  // 3) Populate — best-effort: ошибка/перегруз не ломает ответ, ключ
  // просто не закэшируется (следующий вызов снова miss).
  if (env.KV && typeof env.KV.put === "function") {
    try {
      const text = JSON.stringify({ rows });
      if (text.length <= KVCACHE_VALUE_MAX_CHARS) {
        await env.KV.put(key, text, {
          expirationTtl: Math.max(ttl, KV_PLATFORM_MIN_TTL_SEC),
        });
      }
    } catch {
      // populate не удался — осознанно тихо
    }
  }

  return json({
    rows,
    meta: {
      rowsRead: res.meta?.rows_read ?? null,
      rowsWritten: res.meta?.rows_written ?? null,
      durationMs: res.meta?.duration ?? null,
    },
    kv: env.KV && typeof env.KV.get === "function" ? "miss" : "passthrough",
  });
}

// ——— v2.39.1 (§B2): инвалидация кэша по префиксу ———
// list с пагинацией + параллельные delete; счётчик — по факту выполненных
// delete (не по списку: гонки с populate честно сходятся к «лишний» delete).
async function handleKvInvalidate(env, body) {
  const { prefix } = body ?? {};
  if (typeof prefix !== "string" || !KVCACHE_KEY_RE.test(prefix)) {
    return json({ error: "invalid prefix" }, 400);
  }
  if (!env.KV || typeof env.KV.list !== "function") {
    return json({ invalidated: 0, kv: "disabled" });
  }
  let invalidated = 0;
  let cursor;
  try {
    for (let page = 0; page < KVCACHE_INVALIDATE_MAX_PAGES; page++) {
      const list = await env.KV.list({ prefix, cursor });
      const keys = Array.isArray(list?.keys) ? list.keys : [];
      if (keys.length === 0) break;
      const settled = await Promise.allSettled(
        keys.map((k) => env.KV.delete(k.name))
      );
      invalidated += settled.filter((s) => s.status === "fulfilled").length;
      // пагинация: продолжаем, ТОЛЬКО пока страница не последняя и есть курсор
      if (list?.list_complete || !list?.cursor) break;
      cursor = list.cursor;
    }
  } catch {
    // частичный сбой — отдаём честный счётчик того, что успели
  }
  return json({ invalidated });
}

// ——— v2.40.0 (§B5 + §T-DELTA, docs/OPTIMIZATION-PROPOSAL.md): Cron Triggers ———
// Замена cron-сервисов Render (retention 03:00 / alerts */5 / backup 03:30 /
// github-backup ВС 04:00 / finalize-sessions */5) на Cloudflare Cron Triggers
// воркера + новый */1 worker-tick (драйвер инжест-воркера на безынтервальном
// рантайме — CF Workers; попутно держит приложение тёплым). Планировщик
// живёт в воркере (schedules через Workers API / wrangler.toml [triggers]),
// ИСПОЛНИТЕЛИ остаются в приложении: воркер делает POST APP_ORIGIN+path с
// Bearer CRON_SECRET (те же каналы, что признавали cron-сервисы Render —
// authorizeRequest("cron") / authorizeAdminOrCron). Расписания взяты из
// render.yaml 1:1 ( Blueprint-синк не нужен, cron-сервисы не создаются).
// NB: free-план CF — максимум 5 cron-триггеров на аккаунт, поэтому мигратор
// Turso-дельты свёрнут в общий */5-триггер (шаги миграции троттлятся состоянием
// в KV: blocked → только проба чтения; running → один шаг на тик).
// Нормализация: CF присылает controller.cron в канонической форме («* * * * *»
// вместо «*/1 * * * *», «0» вместо «SUN») — сверяем через нормализатор обе
// стороны, чтобы диспетчер не промахнулся по формату строки.
function normalizeCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const dowMap = { SUN: "0", MON: "1", TUE: "2", WED: "3", THU: "4", FRI: "5", SAT: "6" };
  const fixed = parts.map((p) => (p === "*/1" ? "*" : p));
  const dow = dowMap[String(fixed[4]).toUpperCase()] ?? fixed[4];
  return [fixed[0], fixed[1], fixed[2], fixed[3], dow].join(" ");
}
const CRON_SCHEDULES = {
  "*/1 * * * *": ["tick"],
  "*/5 * * * *": ["finalize-sessions", "alerts", "turso-migrate"],
  "0 3 * * *": ["retention"],
  "30 3 * * *": ["backup"],
  "0 4 * * SUN": ["backup-github"],
};
const CRON_SCHEDULES_BY_NORM = new Map(
  Object.entries(CRON_SCHEDULES).map(([expr, jobs]) => [normalizeCron(expr), jobs])
);
const CRON_APP_PATHS = {
  tick: "/api/worker/tick",
  "finalize-sessions": "/api/cron/finalize-sessions",
  alerts: "/api/cron/alerts",
  retention: "/api/cron/retention",
  backup: "/api/admin/backup",
  "backup-github": "/api/admin/backup/github",
};
const CRON_ALL_JOBS = [
  ...Object.keys(CRON_APP_PATHS),
  "turso-migrate",
];
const CRON_LAST_PREFIX = "cron:last:";
const CRON_BACKUP_TIMEOUT_MS = 14 * 60_000; // дамп+GitHub-аплоад — до 14 мин (лимит cron-инвокации ~15)

async function callAppCron(env, path, timeoutMs = 60_000) {
  if (!env.APP_ORIGIN) return { ok: false, error: "APP_ORIGIN not configured" };
  if (!env.CRON_SECRET) return { ok: false, error: "CRON_SECRET not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(env.APP_ORIGIN + path, {
      method: "POST",
      headers: { authorization: "Bearer " + env.CRON_SECRET, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: bodyText.slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ——— v2.40.0 (§T-DELTA): самовосстанавливающийся мигратор Turso-дельты в D1 ———
// ИНЦИДЕНТ 17-18.09: после деплоя v2.38.2 (21:06 17.09) env-пара D1_GATEWAY_*
// не была выставлена в Render → приложение ушло в законный фолбэк v2.37.0 на
// Turso; записи с 17.09 21:06 → 18.09 08:10 ушли в Turso (чтения Turso
// блокированы квотой free — дельту нельзя вытащить руками). Инцидент закрыт
// 18.09 08:10 (env-пара выставлена через Render API, prod на D1), дельта
// осталась заморожена в Turso ДО сброса квоты чтений.
// Этот конвейер переносит дельту САМ: Cron Trigger каждые 30 мин (и ручной
// POST /admin/turso-migrate {steps:N}) делает ограниченные шаги (лимит строк
// на шаг — под CPU-бюджет инвокации): проба чтения Turso (BLOCKED → статус
// "blocked", ретрай через 30 мин) → выгрузка пачки дельта-строк →
// идемпотентная запись в D1 → прогресс в KV (turso_delta:v1).
// Идемпотентность: GpsPoint/IngestMessage/AuditLog/Route — INSERT OR IGNORE
// по PK; Session/Trip/TrafficJob/User/Setting — сравнение updatedAt, пишется
// ТОЛЬКО более свежая Turso-строка (защита от отката D1-изменений, сделанных
// ПОСЛЕ возвращения прода на D1). Маркер окна = 21:00 17.09 (запас 6 мин до
// реального разъезда); строка «на стыке» идемпотентно дедуплицируется.
const TURSO_STATE_KEY = "turso_delta:v1";
const TURSO_SPLIT_ISO = "2026-09-17T21:00:00.000Z";
const TURSO_SPLIT_MS = Date.parse(TURSO_SPLIT_ISO);
const TURSO_GPS_PAGE = 1500; // строк на шаг GpsPoint (1500 × ~10 колонок ≈ 15k параметров чанками)
const TURSO_SMALL_LIMIT = 5000; // верхний порог «малой» таблицы (один шаг целиком)
const TURSO_PHASES = [
  { table: "User", mode: "compare", where: null },
  { table: "Setting", mode: "compare", where: null },
  { table: "Session", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Trip", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "TrafficJob", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Route", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "IngestMessage", mode: "ignore", where: "firstSeenAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "AuditLog", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "GpsPoint", mode: "ignore-keyset", where: null },
];

function newTursoState() {
  return {
    status: "pending",
    phase: 0,
    lastTs: TURSO_SPLIT_MS,
    lastId: "",
    stats: {},
    blockedCount: 0,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastAttemptAt: null,
    lastError: null,
  };
}

async function loadTursoState(env) {
  if (!env.KV) return { ...newTursoState(), status: "no-kv" };
  try {
    const raw = await env.KV.get(TURSO_STATE_KEY);
    if (!raw) return newTursoState();
    const s = JSON.parse(raw);
    if (s && typeof s === "object" && typeof s.phase === "number" && s.stats && typeof s.stats === "object") {
      return { ...newTursoState(), ...s };
    }
  } catch {
    // битая запись KV — начинаем сначала (идемпотентность миграции это позволяет)
  }
  return newTursoState();
}

async function saveTursoState(env, state) {
  if (!env.KV) return;
  try {
    await env.KV.put(TURSO_STATE_KEY, JSON.stringify(state));
  } catch {
    // KV недоступен — состояние живёт только в памяти текущей инвокации
  }
}

// Turso libSQL-over-HTTP (v2/pipeline, чистый fetch — без клиентов):
// толерантный парсер значений — v2-формат {type,value} и сырые JSON-скаляры.
function tursoValueToJs(v) {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  const t = String(v.type || "");
  const val = v.value;
  if (t === "integer" || t === "float") return val == null ? null : Number(val);
  if (t === "text") return val == null ? null : String(val);
  if (t === "blob") {
    if (typeof val !== "string" || val === "") return null;
    try {
      const bin = atob(val);
      return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return val ?? null;
}

async function tursoExecute(env, sql, args = []) {
  const url = env.TURSO_URL || "";
  const token = env.TURSO_AUTH_TOKEN || "";
  if (!url || !token) return { ok: false, code: "CONFIG", error: "TURSO_URL/TURSO_AUTH_TOKEN not configured" };
  try {
    const res = await fetch(String(url).replace(/\/+$/, "") + "/v2/pipeline", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }] }),
    });
    if (!res.ok) return { ok: false, code: "HTTP_" + res.status, error: "turso http " + res.status };
    const data = await res.json();
    const first = data && data.results && data.results[0];
    if (!first) return { ok: false, code: "EMPTY", error: "turso: empty pipeline response" };
    if (first.type === "error") {
      const e = first.error || {};
      return { ok: false, code: String(e.code || "ERROR"), error: String(e.message || "turso error") };
    }
    const result = (first.response && first.response.result) || {};
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((raw) => {
      const row = {};
      cols.forEach((c, i) => {
        row[c] = tursoValueToJs(raw[i]);
      });
      return row;
    });
    return { ok: true, rows, cols };
  } catch (err) {
    return { ok: false, code: "NETWORK", error: String((err && err.message) || err) };
  }
}

// D1-значения для bind: BigInt→Number (эпоха-мс < 2^53, см. backup.ts),
// Uint8Array→ArrayBuffer, прочее как есть.
function d1BindValue(v) {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return v.buffer && v.byteLength ? v : null;
  return String(v);
}

// Идентификаторы колонок приходят из СХЕМЫ Turso (SELECT *) — доверенные,
// но валидируем паттерном перед интерполяцией в SQL-текст (defense-in-depth).
const SAFE_IDENT_RE = /^[A-Za-z0-9_]+$/;

// Многострочный INSERT (OR IGNORE|OR REPLACE) чанками ≤90 параметров на
// стейтмент (лимит D1 — 100; запас — как в db.ts/multiRowInsertChunk).
function d1InsertChunks(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => SAFE_IDENT_RE.test(c));
  if (!cols.length) return [];
  const rowsPerStmt = Math.max(1, Math.floor(90 / cols.length));
  const action = mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const colList = cols.map((c) => '"' + c + '"').join(",");
  const out = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const placeholders = slice.map(() => "(" + cols.map(() => "?").join(",") + ")").join(",");
    const params = [];
    for (const r of slice) {
      for (const c of cols) params.push(d1BindValue(r[c]));
    }
    out.push({ sql: action + ' INTO "' + table + '" (' + colList + ") VALUES " + placeholders, params });
  }
  return out;
}

async function d1RunInserts(env, table, rows, mode) {
  const chunks = d1InsertChunks(table, rows, mode);
  let written = 0;
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100).map((s) => {
      const st = env.DB.prepare(s.sql);
      return s.params.length ? st.bind(...s.params) : st;
    });
    const results = await env.DB.batch(batch);
    for (const r of results) written += Number((r.meta && r.meta.changes) || 0);
  }
  return written;
}

function bumpTableStat(state, table, key, n) {
  if (!state.stats[table]) state.stats[table] = { scanned: 0, written: 0 };
  state.stats[table][key] = (state.stats[table][key] || 0) + n;
}

// Фаза «compare»: таблицы с updatedAt (User/Setting/Session/Trip/TrafficJob).
// Из Turso — строки дельта-окна (или все), из D1 — текущие updatedAt тех же id;
// переносим ТОЛЬКО строки, которых в D1 нет ИЛИ где Turso-строка свежее.
async function migrateCompareTable(env, phase, state) {
  const sql = phase.where
    ? 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where
    : 'SELECT * FROM "' + phase.table + '"';
  const t = await tursoExecute(env, sql, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const idCol = phase.table === "Setting" ? "key" : "id";
  const d1map = new Map();
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400).map((r) => String(r[idCol]));
    if (!slice.length) continue;
    const st = env.DB.prepare(
      'SELECT "' + idCol + '" AS k, "updatedAt" AS u FROM "' + phase.table + '" WHERE "' + idCol + '" IN (' + slice.map(() => "?").join(",") + ")"
    ).bind(...slice);
    const res = await st.all();
    for (const r of res.results || []) d1map.set(String(r.k), r.u == null ? null : String(r.u));
  }
  const fresh = rows.filter((r) => {
    const id = String(r[idCol]);
    if (!d1map.has(id)) return true;
    const d1u = d1map.get(id) || "";
    const tu = r.updatedAt == null ? "" : String(r.updatedAt);
    return tu > d1u; // Turso свежее → перенос; D1 уже обновлён после разъезда → пропускаем
  });
  const written = await d1RunInserts(env, phase.table, fresh, "replace");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}

// Фаза «ignore»: immutable-таблицы по PK (Route/IngestMessage/AuditLog).
async function migrateIgnoreTable(env, phase, state) {
  const t = await tursoExecute(env, 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const written = await d1RunInserts(env, phase.table, rows, "ignore");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}

// Фаза «ignore-keyset»: GpsPoint — страницы по (timestamp, id) от маркера.
async function migrateGpsPointsStep(env, state) {
  const lastTs = typeof state.lastTs === "number" && Number.isFinite(state.lastTs) ? state.lastTs : TURSO_SPLIT_MS;
  const lastId = typeof state.lastId === "string" ? state.lastId : "";
  const t = await tursoExecute(
    env,
    "SELECT * FROM GpsPoint WHERE timestamp > ? OR (timestamp = ? AND id > ?) ORDER BY timestamp, id LIMIT " + TURSO_GPS_PAGE,
    [lastTs, lastTs, lastId]
  );
  if (!t.ok) return t;
  const rows = t.rows;
  const written = rows.length ? await d1RunInserts(env, "GpsPoint", rows, "ignore") : 0;
  bumpTableStat(state, "GpsPoint", "scanned", rows.length);
  bumpTableStat(state, "GpsPoint", "written", written);
  if (rows.length < TURSO_GPS_PAGE) {
    return { ok: true, phaseDone: true, scanned: rows.length, written };
  }
  const last = rows[rows.length - 1];
  state.lastTs = Number(last.timestamp) || lastTs;
  state.lastId = String(last.id || "");
  return { ok: true, phaseDone: false, scanned: rows.length, written };
}

// Один вызов = до maxSteps фазовых шагов (каждый ограничен по строкам —
// CPU-бюджет инвокации воркера). Проба чтения Turso ДО работы: BLOCKED →
// статус "blocked" (cron повторит через 30 мин), состояние не портится.
async function runTursoMigrationStep(env, maxSteps = 1) {
  const state = await loadTursoState(env);
  if (state.status === "done") return { state, alreadyDone: true };
  state.attempts = (state.attempts || 0) + 1;
  state.lastAttemptAt = new Date().toISOString();
  const probe = await tursoExecute(env, "SELECT 1 AS ok");
  if (!probe.ok) {
    if (probe.code === "BLOCKED") {
      state.status = "blocked";
      state.blockedCount = (state.blockedCount || 0) + 1;
      state.lastError = "turso read quota still blocked (probe)";
    } else {
      state.status = "error";
      state.lastError = probe.error;
    }
    await saveTursoState(env, state);
    return { state, probe: probe.code };
  }
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.status = "running";
  state.lastError = null;
  let steps = 0;
  let last = null;
  while (steps < maxSteps && state.phase < TURSO_PHASES.length) {
    const phase = TURSO_PHASES[state.phase];
    if (phase.mode === "ignore-keyset") last = await migrateGpsPointsStep(env, state);
    else if (phase.mode === "compare") last = await migrateCompareTable(env, phase, state);
    else last = await migrateIgnoreTable(env, phase, state);
    if (!last.ok) {
      state.status = "error";
      state.lastError = last.error || "unknown migration step error";
      break;
    }
    steps++;
    if (last.phaseDone) state.phase++;
  }
  if (state.phase >= TURSO_PHASES.length && state.status !== "error") {
    state.status = "done";
    state.finishedAt = new Date().toISOString();
  }
  await saveTursoState(env, state);
  return { state, steps, last };
}

async function readCronStatus(env) {
  const cron = {};
  for (const job of CRON_ALL_JOBS) {
    const raw = env.KV ? await env.KV.get(TURSO_CRON_LAST_KEY(job)) : null;
    try {
      cron[job] = raw ? JSON.parse(raw) : null;
    } catch {
      cron[job] = null;
    }
  }
  return cron;
}

// cron:last:<job> — KV-запись последнего прогона (наблюдаемость без дашборда CF)
function TURSO_CRON_LAST_KEY(job) {
  return CRON_LAST_PREFIX + job;
}

// v2.38.2 (линт): воркер вынесен в именованную переменную ДО export default
// (import/no-anonymous-default-export) — поведение идентично module-syntax.
const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, gateway: "d1", db: env.DB ? "bound" : "missing-binding" });
    }

    // v2.39.1 (§B1): edge-инжест — ДО гейта X-Gateway-Secret: канал имеет
    // собственную авторизацию (INGEST_TOKEN Bearer/?token= Sensor Logger
    // ИЛИ X-Gateway-Secret приложения). Метод/лимит/идемпотентность — внутри.
    // v2.40.0 (§B1-complete): алиас /api/ingest — Sensor Logger при переводе
    // на edge меняет ТОЛЬКО хост (https://d1-gateway.<sub>.workers.dev),
    // путь и токен остаются как у приложения — меньше мест для ошибки.
    if (url.pathname === "/ingest" || url.pathname === "/api/ingest") {
      return await handleEdgeIngest(request, env);
    }

    // v2.40.0 (§B5/§T-DELTA): статус-эндпоинты наблюдаемости (GET, свой
    // секрет-гейт — до общего метод-чека POST-канала).
    if (url.pathname === "/admin/turso-migrate/status" || url.pathname === "/admin/cron-status") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      if (!env.GATEWAY_SECRET || !(await secretEquals(request.headers.get("x-gateway-secret") ?? "", env.GATEWAY_SECRET))) {
        return json({ error: "unauthorized" }, 401);
      }
      const turso = await loadTursoState(env);
      const cron = await readCronStatus(env);
      return json({ turso, cron, schedules: CRON_SCHEDULES, appPaths: CRON_APP_PATHS });
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = request.headers.get("x-gateway-secret") ?? "";
    // v2.38.2 (ревью F33): await — сравнение теперь по SHA-256-дайджестам (async)
    if (!env.GATEWAY_SECRET || !(await secretEquals(secret, env.GATEWAY_SECRET))) {
      return json({ error: "unauthorized" }, 401);
    }

    // v2.38.1 (ревью F1): лимит тела — предчек по content-length (дёшево, до
    // чтения) и фактический по байтам стрима (readBodyLimited ниже).
    // v2.39.1 (§B2): /kvcache/* — отдельный меньший кап (64 КБ: sql+params).
    const maxBody =
      Number(env.GATEWAY_MAX_BODY_BYTES) > 0 ? Number(env.GATEWAY_MAX_BODY_BYTES) : MAX_BODY_BYTES_DEFAULT;
    const bodyLimit =
      url.pathname === "/kvcache" || url.pathname === "/kvcache/invalidate"
        ? Math.min(maxBody, KVCACHE_MAX_BODY_BYTES)
        : maxBody;
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > bodyLimit) {
      return json({ error: "payload too large", limitBytes: bodyLimit }, 413);
    }

    // v2.38.1 (ревью F1): rate-limit ПОСЛЕ auth (без секрета нельзя бесплатно
    // 429-нуть легитимного вызывающего) и ДО чтения тела.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlMax =
      Number(env.GATEWAY_RATE_LIMIT_MAX) > 0 ? Number(env.GATEWAY_RATE_LIMIT_MAX) : RATE_LIMIT_MAX_DEFAULT;
    if (rateLimitExceeded(ip, rlMax, RATE_LIMIT_WINDOW_MS)) {
      return json({ error: "rate limit exceeded", retryAfterSec: 60, limit: rlMax }, 429);
    }

    const bodyRes = await readBodyLimited(request, bodyLimit);
    if (!bodyRes.ok) {
      return json({ error: bodyRes.error, limitBytes: bodyRes.limitBytes }, bodyRes.status);
    }
    let body;
    try {
      body = JSON.parse(bodyRes.text);
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    try {
      if (url.pathname === "/query") {
        const { sql, params } = body ?? {};
        if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
        // v2.38.1 (ревью F1): вайтлист операций ДО prepare/exec
        const violation = validateStatement(sql, isReadOnly(env));
        if (violation) return json({ error: "forbidden", reason: violation }, 403);
        let stmt = env.DB.prepare(sql);
        if (Array.isArray(params) && params.length > 0) stmt = stmt.bind(...params.map(normParam));
        const res = await stmt.all();
        return json({
          rows: bigintSafe(res.results ?? []),
          rowsAffected: res.meta?.changes ?? 0,
          meta: {
            rowsRead: res.meta?.rows_read ?? null,
            rowsWritten: res.meta?.rows_written ?? null,
            durationMs: res.meta?.duration ?? null,
          },
        });
      }

      // v2.39.1 (§B2): KV-кэш и инвалидация — те же гейты (секрет,
      // rate-limit, лимит тела 64 КБ), handler-логика выше по файлу.
      if (url.pathname === "/kvcache") {
        return await handleKvCache(env, body);
      }
      if (url.pathname === "/kvcache/invalidate") {
        return await handleKvInvalidate(env, body);
      }

      // v2.40.0 (§T-DELTA): ручной запуск мигратора Turso-дельты (шаги
      // ограничены телом {steps:1..40}; {reset:true} — сброс прогресса KV).
      // Гейты те же: секрет шлюза + rate-limit + лимит тела.
      if (url.pathname === "/admin/turso-migrate") {
        if (body && body.reset === true) {
          const state = newTursoState();
          await saveTursoState(env, state);
          return json({ state, reset: true });
        }
        const steps = Math.min(Math.max(Number((body && body.steps) || 1) || 1, 1), 40);
        const result = await runTursoMigrationStep(env, steps);
        return json(result);
      }

      if (url.pathname === "/batch") {
        const { statements } = body ?? {};
        if (!Array.isArray(statements) || statements.length === 0) {
          return json({ error: "statements required" }, 400);
        }
        if (statements.length > 500) {
          return json({ error: "too many statements (max 500 per batch)" }, 400);
        }
        // v2.38.1 (ревью F1): вайтлист операций — ВСЕ стейтменты батча ДО
        // построения prepare-объектов (атомарный batch не начинает исполняться)
        // v2.38.2 (ревью F33): + read-only флаг (один вызов isReadOnly на батч)
        const batchReadOnly = isReadOnly(env);
        for (const s of statements) {
          if (typeof s?.sql !== "string" || s.sql.length === 0) {
            return json({ error: "each statement requires non-empty sql" }, 400);
          }
          const violation = validateStatement(s.sql, batchReadOnly);
          if (violation) {
            return json({ error: "forbidden", reason: violation }, 403);
          }
        }
        const stmts = statements.map((s) => {
          let st = env.DB.prepare(s.sql);
          if (Array.isArray(s.params) && s.params.length > 0) {
            st = st.bind(...s.params.map(normParam));
          }
          return st;
        });
        // env.DB.batch = АТОМАРНАЯ транзакция: либо все стейтменты, либо ничего.
        const results = await env.DB.batch(stmts);
        return json(results.map((r) => ({
          rows: bigintSafe(r.results ?? []),
          rowsAffected: r.meta?.changes ?? 0,
          meta: {
            rowsRead: r.meta?.rows_read ?? null,
            rowsWritten: r.meta?.rows_written ?? null,
            durationMs: r.meta?.duration ?? null,
          },
        })));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err?.message ?? err), d1: true }, 500);
    }
  },

  // v2.40.0 (§B5): Cron Triggers — планировщик бывших cron-сервисов Render.
  // Каждый тик: разбор расписания → вызов исполнителей приложения (или
  // внутренний шаг мигратора Turso) → запись cron:last:<job> в KV
  // (наблюдаемость через GET /admin/cron-status) + структурный лог.
  async scheduled(controller, env, ctx) {
    // нормализуем ОБЕ стороны (ключи карты и controller.cron): CF может
    // прислать выражение как в канонической форме («* * * * *»), так и
    // дословно («*/1 * * * *») — точное сравнение ненадёжно в обе стороны.
    const jobs = CRON_SCHEDULES_BY_NORM.get(normalizeCron(controller.cron)) ?? [];
    const run = (async () => {
      const results = {};
      for (const job of jobs) {
        try {
          if (job === "turso-migrate") {
            const r = await runTursoMigrationStep(env, 1);
            results[job] = {
              ok: r.state.status !== "error",
              state: {
                status: r.state.status,
                phase: r.state.phase,
                stats: r.state.stats,
                blockedCount: r.state.blockedCount,
                lastError: r.state.lastError,
              },
            };
            if (env.KV) {
              try {
                await env.KV.put(
                  TURSO_CRON_LAST_KEY(job),
                  JSON.stringify({ at: new Date().toISOString(), ok: results[job].ok, state: results[job].state })
                );
              } catch {}
            }
          } else {
            const path = CRON_APP_PATHS[job];
            const timeout = job === "backup" ? CRON_BACKUP_TIMEOUT_MS : 60_000;
            const r = await callAppCron(env, path, timeout);
            results[job] = r;
            if (env.KV) {
              try {
                await env.KV.put(
                  TURSO_CRON_LAST_KEY(job),
                  JSON.stringify({
                    at: new Date().toISOString(),
                    ok: r.ok,
                    status: r.status ?? null,
                    error: r.error ?? null,
                  })
                );
              } catch {}
            }
          }
        } catch (err) {
          results[job] = { ok: false, error: String((err && err.message) || err) };
        }
      }
      console.log(JSON.stringify({ level: "info", msg: "d1-gateway cron run", cron: controller.cron, jobs, results }));
    })();
    ctx.waitUntil(run);
  },
};

export default worker;
