// tests/kvcache-server.test.ts — v2.39.1 (§B2): юнит-тесты СЕРВЕРНОЙ половины
// KV-кэша на d1-gateway-воркере (cloudflare-worker/d1-gateway.js) + монтаж
// §B1 /ingest в роутер. Контракт сверяется с src/lib/edge-gateway.ts:
//   POST /kvcache {key, sql, params, ttlSec} → {rows, meta, kv: hit|miss|passthrough}
//   POST /kvcache/invalidate {prefix} → {invalidated}
// Проверяются: гейты (секрет/401, лимит тела 64 КБ/413, валидация ключа/TTL/
// параметров), read-only вайтлист (DML и чужие таблицы → 403 ДО исполнения),
// cache-aside (miss → populate с TTL-полом 60с, hit → без обращения к D1,
// битая KV-запись → delete+miss), кап значения 512 КБ, инвалидация с
// пагинацией list, обратная совместимость без биндинга KV (passthrough),
// регрессия /query и монтаж /ingest (своя авторизация INGEST_TOKEN).
import { describe, it, expect } from "vitest";
import workerMod from "../cloudflare-worker/d1-gateway.js";

const worker = workerMod as { fetch: (req: Request, env: Record<string, unknown>) => Promise<Response> };

const SECRET = "unit-test-gateway-secret-48-chars-aaaaaaaaaaaa";

type DbCall = { sql: string; args: unknown[] };

/** D1-мок для /query и /kvcache: prepare→bind(*args)→all(); фиксирует вызовы. */
function makeDb(results: Record<string, unknown>[] = [{ n: 1 }]) {
  const calls: DbCall[] = [];
  const meta = { rows_read: 42, changes: 0, duration: 1.25 };
  function stmt(sql: string, args: unknown[]) {
    return {
      bind: (...a: unknown[]) => stmt(sql, a),
      all: async () => {
        calls.push({ sql, args });
        return { results, meta };
      },
      first: async () => null,
      run: async () => ({ meta }),
    };
  }
  return { db: { prepare: (sql: string) => stmt(sql, []) }, calls };
}

/** KV-мок: Map-хранилище, journal put/delete/list для assert'ов. */
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const deletes: string[] = [];
  const lists: Array<{ prefix?: string; cursor?: string }> = [];
  return {
    kv: {
      get: async (key: string) => (store.has(key) ? store.get(key) : null),
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        puts.push({ key, value, ttl: opts?.expirationTtl });
        store.set(key, value);
      },
      delete: async (key: string) => {
        deletes.push(key);
        store.delete(key);
      },
      list: async (opts?: { prefix?: string; cursor?: string }) => {
        lists.push(opts ?? {});
        const prefix = opts?.prefix ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true };
      },
    },
    store,
    puts,
    deletes,
    lists,
  };
}

async function post(
  path: string,
  body: unknown,
  env: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  // env по умолчанию содержит валидный секрет (как прод-биндинг); тесты
  // «без авторизации» переопределяют его пустым значением/заголовком.
  const envFull = { GATEWAY_SECRET: SECRET, ...env };
  return worker.fetch(
    new Request(`https://gw.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": SECRET, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envFull
  );
}

const selectSql = "SELECT COUNT(*) AS n FROM GpsPoint";

describe("§B2 /kvcache — гейты и валидация", () => {
  it("без X-Gateway-Secret → 401 (общий гейт роутера)", async () => {
    const { db } = makeDb();
    const res = await post("/kvcache", { key: "dash:k", sql: selectSql, params: [] }, { DB: db }, {
      "x-gateway-secret": "",
    });
    expect(res.status).toBe(401);
  });

  it("ключ с пробелом/юникодом → 400 до всякого D1", async () => {
    const { db, calls } = makeDb();
    const res = await post("/kvcache", { key: "bad key", sql: selectSql, params: [] }, { DB: db });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("пустой ключ и ключ длиннее 128 → 400", async () => {
    const { db } = makeDb();
    expect((await post("/kvcache", { key: "", sql: selectSql, params: [] }, { DB: db })).status).toBe(400);
    expect((await post("/kvcache", { key: "k".repeat(129), sql: selectSql, params: [] }, { DB: db })).status).toBe(400);
  });

  it("params не массив / >100 → 400", async () => {
    const { db } = makeDb();
    expect((await post("/kvcache", { key: "dash:k", sql: selectSql, params: "x" }, { DB: db })).status).toBe(400);
    expect(
      (await post("/kvcache", { key: "dash:k", sql: selectSql, params: new Array(101).fill(0) }, { DB: db })).status
    ).toBe(400);
  });

  it("ttlSec вне 1..3600 → 400", async () => {
    const { db } = makeDb();
    expect((await post("/kvcache", { key: "dash:k", sql: selectSql, params: [], ttlSec: 0 }, { DB: db })).status).toBe(400);
    expect((await post("/kvcache", { key: "dash:k", sql: selectSql, params: [], ttlSec: 3601 }, { DB: db })).status).toBe(400);
  });

  it("INSERT через /kvcache → 403 (read-only вайтлист), D1 не зовётся", async () => {
    const { db, calls } = makeDb();
    const res = await post(
      "/kvcache",
      { key: "dash:k", sql: "INSERT INTO GpsPoint (id) VALUES (?)", params: ["x"] },
      { DB: db }
    );
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("SELECT по sqlite_master → 403 (чужая таблица)", async () => {
    const { db, calls } = makeDb();
    const res = await post("/kvcache", { key: "dash:k", sql: "SELECT name FROM sqlite_master", params: [] }, { DB: db });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("тело > 64 КБ → 413 (отдельный кап kvcache, не общий 2 МБ)", async () => {
    const { db } = makeDb();
    const big = "SELECT " + "a".repeat(70_000);
    const res = await post("/kvcache", { key: "dash:k", sql: big, params: [] }, { DB: db });
    expect(res.status).toBe(413);
    const data = (await res.json()) as { limitBytes?: number };
    expect(data.limitBytes).toBe(64 * 1024);
  });
});

describe("§B2 /kvcache — cache-aside поведение", () => {
  it("miss: исполняет SELECT, кладёт в KV с TTL-полом 60с (ttlSec=30)", async () => {
    const { db, calls } = makeDb();
    const { kv, puts } = makeKv();
    const res = await post("/kvcache", { key: "dash:sessions:2026-09-18:9", sql: selectSql, params: [], ttlSec: 30 }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rows: unknown[]; kv: string; meta: { rowsRead: number } };
    expect(data.kv).toBe("miss");
    expect(data.rows).toEqual([{ n: 1 }]);
    expect(data.meta.rowsRead).toBe(42);
    expect(calls.length).toBe(1);
    expect(puts.length).toBe(1);
    expect(puts[0].key).toBe("dash:sessions:2026-09-18:9");
    expect(puts[0].ttl).toBe(60);
  });

  it("hit: rows из KV, D1 НЕ зовётся", async () => {
    const { db, calls } = makeDb();
    const { kv } = makeKv({ "dash:k": JSON.stringify({ rows: [{ n: 99 }] }) });
    const res = await post("/kvcache", { key: "dash:k", sql: selectSql, params: [] }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { rows: unknown[]; kv: string };
    expect(data.kv).toBe("hit");
    expect(data.rows).toEqual([{ n: 99 }]);
    expect(calls.length).toBe(0);
  });

  it("битая KV-запись → delete + перезапрос через D1 (miss)", async () => {
    const { db, calls } = makeDb();
    const { kv, deletes } = makeKv({ "dash:k": "{not-json" });
    const res = await post("/kvcache", { key: "dash:k", sql: selectSql, params: [] }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { kv: string };
    expect(data.kv).toBe("miss");
    expect(deletes).toContain("dash:k");
    expect(calls.length).toBe(1);
  });

  it("нет биндинга KV → passthrough, прямой D1-запрос", async () => {
    const { db, calls } = makeDb();
    const res = await post("/kvcache", { key: "dash:k", sql: selectSql, params: [] }, {
      DB: db,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { kv: string };
    expect(data.kv).toBe("passthrough");
    expect(calls.length).toBe(1);
  });

  it("значение больше 512 КБ не кэшируется, но rows отдаются", async () => {
    const wide = Array.from({ length: 20_000 }, (_, i) => ({ payload: "x".repeat(30), i }));
    const { db, calls } = makeDb(wide);
    const { kv, puts } = makeKv();
    const res = await post("/kvcache", { key: "dash:wide", sql: selectSql, params: [] }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { rows: unknown[]; kv: string };
    expect(data.kv).toBe("miss");
    expect(data.rows.length).toBe(20_000);
    expect(puts.length).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("params прокидываются в bind (нормализация boolean→1)", async () => {
    const { db, calls } = makeDb();
    const res = await post("/kvcache", { key: "dash:p", sql: "SELECT id FROM Session WHERE active = ?", params: [true] }, {
      DB: db,
      GATEWAY_SECRET: SECRET,
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual([1]);
  });
});

describe("§B2 /kvcache/invalidate", () => {
  it("сбрасывает по префиксу (list + delete), счётчик по факту", async () => {
    const { db } = makeDb();
    const { kv, deletes } = makeKv({
      "dash:a:1": "{}",
      "dash:a:2": "{}",
      "dash:b:1": "{}",
    });
    const res = await post("/kvcache/invalidate", { prefix: "dash:a:" }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { invalidated: number };
    expect(data.invalidated).toBe(2);
    expect(deletes.sort()).toEqual(["dash:a:1", "dash:a:2"]);
  });

  it("невалидный префикс → 400", async () => {
    const { db } = makeDb();
    const res = await post("/kvcache/invalidate", { prefix: "bad prefix" }, { DB: db });
    expect(res.status).toBe(400);
  });

  it("без KV → {invalidated: 0, kv: \"disabled\"}", async () => {
    const { db } = makeDb();
    const res = await post("/kvcache/invalidate", { prefix: "dash:" }, { DB: db });
    const data = (await res.json()) as { invalidated: number; kv: string };
    expect(data.invalidated).toBe(0);
    expect(data.kv).toBe("disabled");
  });

  it("пагинация list: две страницы по курсору суммируются", async () => {
    const { db } = makeDb();
    // собственный KV-мок с курсорной пагинацией по 1 ключу
    const store = new Map<string, string>([
      ["dash:pg:1", "{}"],
      ["dash:pg:2", "{}"],
      ["dash:pg:3", "{}"],
    ]);
    const pages: Array<Array<{ name: string }>> = [
      [...store.keys()].slice(0, 1).map((name) => ({ name })),
      [...store.keys()].slice(1, 2).map((name) => ({ name })),
      [...store.keys()].slice(2).map((name) => ({ name })),
    ];
    let call = 0;
    const deletes: string[] = [];
    const kv = {
      get: async () => null,
      put: async () => {},
      delete: async (key: string) => {
        deletes.push(key);
      },
      list: async (opts?: { prefix?: string; cursor?: string }) => {
        const i = call++;
        const isLast = i === pages.length - 1;
        return { keys: pages[i], list_complete: isLast, cursor: isLast ? undefined : `cursor-${i}` };
      },
    };
    const res = await post("/kvcache/invalidate", { prefix: "dash:pg:" }, {
      DB: db,
      KV: kv,
      GATEWAY_SECRET: SECRET,
    });
    const data = (await res.json()) as { invalidated: number };
    expect(data.invalidated).toBe(3);
    expect(call).toBe(3);
    expect(deletes.length).toBe(3);
  });
});

describe("§B1 монтаж /ingest в роутер d1-gateway", () => {
  it("GET /ingest → 405 (метод-гард порта)", async () => {
    const res = await worker.fetch(new Request("https://gw.test/ingest", { method: "GET" }), {
      INGEST_TOKEN: "ingest-token-aaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(res.status).toBe(405);
  });

  it("POST /ingest без авторизации → 401 (не проходит мимо своей auth)", async () => {
    const res = await post(
      "/ingest",
      { deviceId: "sensor-logger-alpha", clientId: "b-1", points: [{ lat: 51.53, lon: 46.03, speed: 1, timestamp: Date.now() }] },
      { GATEWAY_SECRET: SECRET },
      { "x-gateway-secret": "" }
    );
    expect(res.status).toBe(401);
    const data = (await res.json()) as { reason?: string };
    expect(data.reason).toContain("INGEST_TOKEN");
  });

  it("POST /ingest с Bearer INGEST_TOKEN → 201 (паритет с /api/ingest)", async () => {
    const batchCalls: unknown[][] = [];
    const stmt = (sql: string, args: unknown[]) => ({
      bind: (...a: unknown[]) => stmt(sql, a),
      first: async () => null,
      run: async () => ({ meta: {} }),
      all: async () => ({ results: [], meta: {} }),
    });
    const db = {
      prepare: (sql: string) => stmt(sql, []),
      batch: async (stmts: unknown[]) => {
        batchCalls.push(stmts);
        return stmts.map(() => ({ results: [], meta: { changes: 1 } }));
      },
    };
    const now = Date.now();
    const res = await post(
      "/ingest",
      {
        deviceId: "sensor-logger-alpha",
        clientId: `edge-${now}`,
        points: [{ lat: 51.53, lon: 46.03, speed: 12.5, accuracy: 8, bearing: 90, timestamp: now }],
      },
      { DB: db, INGEST_TOKEN: "ingest-token-aaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { authorization: "Bearer ingest-token-aaaaaaaaaaaaaaaaaaaaaaaaaa", "x-gateway-secret": "" }
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string; pointsAccepted: number; duplicate: boolean };
    expect(data.pointsAccepted).toBe(1);
    expect(data.duplicate).toBe(false);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("§A1 StatsRollup в вайтлисте (v2.39.1)", () => {
  it("/query SELECT из StatsRollup разрешён (для v2.39.0-приложения)", async () => {
    const { db, calls } = makeDb();
    const res = await post("/query", { sql: "SELECT day, points FROM StatsRollup", params: [] }, { DB: db });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("/query CREATE TABLE IF NOT EXISTS StatsRollup (ленивый DDL приложения)", async () => {
    const { db, calls } = makeDb();
    const ddl = `CREATE TABLE IF NOT EXISTS StatsRollup (\n  day TEXT NOT NULL,\n  userId TEXT NOT NULL DEFAULT '',\n  PRIMARY KEY (day, userId)\n)`;
    const res = await post("/query", { sql: ddl, params: [] }, { DB: db });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("/query INSERT INTO StatsRollup разрешён (инкременты §A1.5)", async () => {
    const { db } = makeDb();
    const res = await post("/query", {
      sql: "INSERT INTO StatsRollup (day, userId, sessions, points) VALUES (?, ?, 1, 1)",
      params: ["2026-09-18", ""],
    }, { DB: db });
    expect(res.status).toBe(200);
  });

  it("/kvcache SELECT из StatsRollup проходит read-only гейт", async () => {
    const { db } = makeDb();
    const res = await post("/kvcache", { key: "dash:rollup", sql: "SELECT SUM(points) AS p FROM StatsRollup", params: [] }, { DB: db });
    expect(res.status).toBe(200);
  });

  it("CREATE TABLE для прочих имён по-прежнему 403", async () => {
    const { db, calls } = makeDb();
    const res = await post("/query", { sql: "CREATE TABLE IF NOT EXISTS Evil (x TEXT)", params: [] }, { DB: db });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });
});

describe("Регрессия /query + /health", () => {
  it("/query SELECT с секретом работает как прежде", async () => {
    const { db, calls } = makeDb();
    const res = await post("/query", { sql: selectSql, params: [] }, { DB: db });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rows: unknown[]; meta: { rowsRead: number } };
    expect(data.rows).toEqual([{ n: 1 }]);
    expect(data.meta.rowsRead).toBe(42);
    expect(calls.length).toBe(1);
  });

  it("/health GET остаётся без авторизации", async () => {
    const res = await worker.fetch(new Request("https://gw.test/health", { method: "GET" }), { DB: {} });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; db: string };
    expect(data.ok).toBe(true);
    expect(data.db).toBe("bound");
  });
});
