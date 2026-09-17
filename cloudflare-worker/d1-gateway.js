// d1-gateway — аутентифицированный SQL-шлюз над Cloudflare D1.
// Деплой: Workers API (module syntax). БД привязана биндингом DB.
// Auth: заголовок X-Gateway-Secret (секрет GATEWAY_SECRET в env воркера).
//
// Эндпоинты:
//   GET  /health                          → {ok, gateway:"d1", db:"bound"}
//   POST /query   {sql, params?}          → {rows, rowsAffected, meta}
//   POST /batch   {statements:[{sql,params}]} → АТОМАРНО → [{rows, rowsAffected, meta}, ...]
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

// v2.38.2 (линт): воркер вынесен в именованную переменную ДО export default
// (import/no-anonymous-default-export) — поведение идентично module-syntax.
const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, gateway: "d1", db: env.DB ? "bound" : "missing-binding" });
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = request.headers.get("x-gateway-secret") ?? "";
    // v2.38.2 (ревью F33): await — сравнение теперь по SHA-256-дайджестам (async)
    if (!env.GATEWAY_SECRET || !(await secretEquals(secret, env.GATEWAY_SECRET))) {
      return json({ error: "unauthorized" }, 401);
    }

    // v2.38.1 (ревью F1): лимит тела — предчек по content-length (дёшево, до
    // чтения) и фактический по байтам стрима (readBodyLimited ниже).
    const maxBody =
      Number(env.GATEWAY_MAX_BODY_BYTES) > 0 ? Number(env.GATEWAY_MAX_BODY_BYTES) : MAX_BODY_BYTES_DEFAULT;
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > maxBody) {
      return json({ error: "payload too large", limitBytes: maxBody }, 413);
    }

    // v2.38.1 (ревью F1): rate-limit ПОСЛЕ auth (без секрета нельзя бесплатно
    // 429-нуть легитимного вызывающего) и ДО чтения тела.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlMax =
      Number(env.GATEWAY_RATE_LIMIT_MAX) > 0 ? Number(env.GATEWAY_RATE_LIMIT_MAX) : RATE_LIMIT_MAX_DEFAULT;
    if (rateLimitExceeded(ip, rlMax, RATE_LIMIT_WINDOW_MS)) {
      return json({ error: "rate limit exceeded", retryAfterSec: 60, limit: rlMax }, 429);
    }

    const bodyRes = await readBodyLimited(request, maxBody);
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
};

export default worker;
