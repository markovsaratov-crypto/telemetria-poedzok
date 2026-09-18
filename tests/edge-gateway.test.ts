// tests/edge-gateway.test.ts — v2.39.0 (§B2): юнит-тесты HTTP-клиента
// KV-кэша гейтвей-воркера. Модули подключаются ДИНАМИЧЕСКИ после выставления
// env-переменных (db.ts читает D1_GATEWAY_URL в момент ЗАГРУЗКИ модуля, а
// env() кэшируется при первом вызове) — статический import в шапке обгонял бы
// присвоение process.env. Глобальный fetch подменён моком: «воркер»
// http://gw.test отвечает скриптованными JSON-ответами, прямой путь D1 —
// ответом /query в формате адаптера db-d1.ts. Сеть реальная не трогается.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// ——— §B2-режим ДО импорта модулей (см. шапку) ———
process.env.D1_GATEWAY_URL = "http://gw.test";
process.env.D1_GATEWAY_SECRET = "test-secret";
process.env.EDGE_KVCACHE_ENABLED = "true";

type EdgeGatewayModule = typeof import("../src/lib/edge-gateway");
type MetricsModule = typeof import("../src/lib/metrics");
let edge: EdgeGatewayModule;
let metrics: MetricsModule;

beforeAll(async () => {
  [edge, metrics] = await Promise.all([
    import("../src/lib/edge-gateway"),
    import("../src/lib/metrics"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Ответ «воркера» /kvcache в его контракт-формате (§B2, edge-gateway.ts). */
const kvResponse = (rows: Array<Record<string, unknown>>, kv: "hit" | "miss") =>
  new Response(JSON.stringify({ rows, kv }), { status: 200, headers: { "content-type": "application/json" } });

/** Ответ D1-адаптера /query (формат libsql ResultSet — db-d1.ts). */
const queryResponse = (rows: Array<Record<string, unknown>>) =>
  new Response(JSON.stringify({ rows, rowsAffected: 0, meta: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Сигнатура глобального fetch — чтобы vi.fn выводил тип аргументов вызовов. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

describe("§B2 edgeKvEnabled — флаг И D1-гейтвей в окружении", () => {
  it("режим выставлен (URL+секрет+флаг) → true", () => {
    expect(edge.edgeKvEnabled()).toBe(true);
  });
});

describe("§B2 edgeKvQuery — cache-aside через /kvcache", () => {
  it("HIT: rows из KV, kv:'hit', запрос ушёл в /kvcache с секретом и телом контракта", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => kvResponse([{ c: 42 }], "hit"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await edge.edgeKvQuery("dash:own:2026-09-18", "SELECT COUNT(*) AS c FROM Session", [], 30);
    expect(r.kv).toBe("hit");
    expect(r.rows).toEqual([{ c: 42 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, initArg] = fetchMock.mock.calls[0] as Parameters<FetchLike>;
    expect(String(url)).toBe("http://gw.test/kvcache");
    const init = (initArg ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)["x-gateway-secret"]).toBe("test-secret");
    const body = JSON.parse(String(init.body)) as { key: string; sql: string; params: unknown[]; ttlSec: number };
    expect(body.key).toBe("dash:own:2026-09-18");
    expect(body.sql).toContain("SELECT");
    expect(body.params).toEqual([]);
    expect(body.ttlSec).toBe(30);
  });

  it("MISS: воркер наполнил кэш (rows в ответе, kv:'miss') — счётчик miss растёт", async () => {
    const before = metrics.counterValue("edge_kv_miss_total");
    vi.stubGlobal("fetch", vi.fn(async () => kvResponse([{ c: 7 }], "miss")));
    const r = await edge.edgeKvQuery("k2", "SELECT 1 AS c", []);
    expect(r.kv).toBe("miss");
    expect(r.rows).toEqual([{ c: 7 }]);
    expect(metrics.counterValue("edge_kv_miss_total")).toBe((before ?? 0) + 1);
  });

  it("404 (воркер ещё НЕ обновлён — задокументированное состояние) → прямой /query, kv:'error'", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/kvcache")
        ? new Response(JSON.stringify({ error: "not found" }), { status: 404 })
        : queryResponse([{ c: 5 }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await edge.edgeKvQuery("k3", "SELECT COUNT(*) AS c FROM Session", []);
    expect(r.kv).toBe("error");
    expect(r.rows).toEqual([{ c: 5 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // /kvcache → 404, затем /query
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://gw.test/query");
  });

  it("сетевой сбой fetch → тот же фолбэк на прямой /query (kv:'error'), дашборд жив", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/kvcache") ? Promise.reject(new Error("network down")) : queryResponse([{ c: 3 }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await edge.edgeKvQuery("k4", "SELECT 1 AS c", []);
    expect(r.kv).toBe("error");
    expect(r.rows).toEqual([{ c: 3 }]);
  });

  it("НЕ-SELECT никогда не уходит в /kvcache (дублирующий префикс-гард) — сразу прямой путь", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/kvcache")) throw new Error("kvcache must not be called for non-SELECT");
      return queryResponse([{ n: 1 }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await edge.edgeKvQuery("k5", "PRAGMA table_info(Session)", []);
    expect(r.kv).toBe("passthrough");
    expect(r.rows).toEqual([{ n: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // только /query
  });

  it("SELECT с ведущим комментарием распознаётся как SELECT (гвард по первому глаголу)", async () => {
    // §B1-паритет: SQL в коде многострочный с комментариями — гвард не должен
    // ложно отправить его мимо кэша
    const sql = `-- v2.39.0 dash
      SELECT day, points FROM StatsRollup WHERE day >= ?`;
    const fetchMock = vi.fn(async (_url: string | URL) => kvResponse([], "miss"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await edge.edgeKvQuery("k6", sql, ["2026-09-01"]);
    expect(r.kv).toBe("miss");
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://gw.test/kvcache");
  });
});

describe("§B2 edgeKvInvalidate — fire-and-forget, ошибки глотаются", () => {
  it("успех: POST /kvcache/invalidate с префиксом, промис не всплывает", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ invalidated: 3 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(() => edge.edgeKvInvalidate("dash:")).not.toThrow();
    await new Promise((r) => setTimeout(r, 5)); // fire-and-forget успел уйти
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gw.test/kvcache/invalidate",
      expect.objectContaining({ method: "POST" })
    );
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    const body = JSON.parse(String(init.body)) as { prefix: string };
    expect(body.prefix).toBe("dash:");
  });

  it("сбой воркера — тихо (TTL истечёт сам), исключение наружу НЕ летит", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(() => edge.edgeKvInvalidate("dash:")).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });
});
