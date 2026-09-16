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

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// Сравнение секрета без раннего выхода (timing-safe на длину).
function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, gateway: "d1", db: env.DB ? "bound" : "missing-binding" });
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = request.headers.get("x-gateway-secret") ?? "";
    if (!env.GATEWAY_SECRET || !secretEquals(secret, env.GATEWAY_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    try {
      if (url.pathname === "/query") {
        const { sql, params } = body ?? {};
        if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
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
        const stmts = statements.map((s) => {
          if (typeof s?.sql !== "string" || s.sql.length === 0) {
            throw new Error("each statement requires non-empty sql");
          }
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
