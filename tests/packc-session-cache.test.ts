// tests/packc-session-cache.test.ts — v2.40.9 (Pack C, N-6): ТОЧЕЧНАЯ
// инвалидация кэшей сессий. Инвариант: объём инвалидации = O(повреждённых),
// НЕ O(всех) — глобальный bump v2.40.7 (9→10 ради 2 записей) инвалидировал
// 105 сессий и сжёг ~300–450 тыс. строк чтений (инцидент 20.09).
// SQL не исполняется (как весь канон сьютов) — проверяются СТРУКТУРА
// стейтментов (константы, чанки ≤ бюджета D1) и семантика свежести.
import { describe, it, expect } from "vitest";
import {
  SESSION_CACHE_VERSION,
  SESSION_CACHE_INVALIDATED_VERSION,
  isSessionCacheFresh,
  buildInvalidationStatements,
  type SessionCacheMeta,
} from "../src/lib/session-cache";
import { D1_PARAM_BUDGET } from "../src/lib/db";

const meta = (over: Partial<SessionCacheMeta>): SessionCacheMeta => ({
  id: "s1",
  deviceId: "d1",
  startTime: "2026-09-20T10:00:00.000Z",
  endTime: "2026-09-20T11:00:00.000Z",
  deleted: false,
  routeHash: null,
  topologyHash: null,
  pointCount: 100,
  cachePointCount: 100,
  cacheVersion: SESSION_CACHE_VERSION,
  statsCache: "{}",
  eventsCache: "{}",
  trackCache: "{}",
  ...over,
});

describe("§C N-6: инвариант точечной инвалидации", () => {
  it("помеченная сессия (cacheVersion = -1) протухает, НЕПОМЕЧЕННЫЕ — свежие", () => {
    const damaged = meta({ id: "920ff881", cacheVersion: SESSION_CACHE_INVALIDATED_VERSION });
    const healthy = meta({ id: "08c29265" });
    expect(isSessionCacheFresh(damaged)).toBe(false); // инвалидирована точечно
    expect(isSessionCacheFresh(healthy)).toBe(true); // остальные 103 — НЕ тронуты
    expect(SESSION_CACHE_INVALIDATED_VERSION).not.toBe(SESSION_CACHE_VERSION);
  });

  it("семантика прежняя для прочих причин протухания (состав точек)", () => {
    expect(isSessionCacheFresh(meta({ cachePointCount: 99 }))).toBe(false);
    expect(isSessionCacheFresh(meta({ cacheVersion: SESSION_CACHE_VERSION - 1 }))).toBe(false);
    expect(isSessionCacheFresh(meta({ statsCache: null }))).toBe(true); // базовая семантика без fields
    expect(isSessionCacheFresh(meta({ statsCache: null }), ["stats"])).toBe(false); // честная F51
  });
});

describe("§C N-6: строитель стейтментов buildInvalidationStatements", () => {
  it("200 повреждённых id → ceil(200/90) стейтмента, каждый ≤ бюджета D1", () => {
    const ids = [...Array(200).keys()].map((i) => `id-${i}`);
    const stmts = buildInvalidationStatements(ids);
    expect(stmts.length).toBe(Math.ceil(200 / D1_PARAM_BUDGET));
    for (const stmt of stmts) {
      expect(stmt.sql).toBe(`UPDATE Session SET cacheVersion = ${SESSION_CACHE_INVALIDATED_VERSION} WHERE id IN (${stmt.args.map(() => "?").join(", ")})`);
      expect(stmt.args.length).toBeLessThanOrEqual(D1_PARAM_BUDGET);
      for (const a of stmt.args) expect(typeof a).toBe("string");
    }
    expect(stmts.flatMap((s) => s.args)).toEqual(ids); // все id покрыты ровно раз
  });

  it("пустой вход / мусор → ноль стейтментов (бесплатно)", () => {
    expect(buildInvalidationStatements([])).toHaveLength(0);
    expect(buildInvalidationStatements(["", null as unknown as string, "ok"])).toHaveLength(1);
  });

  it("дубликаты id дедуплицируются (O(уникальных), не O(вызовов)", () => {
    const stmts = buildInvalidationStatements(["a", "a", "b"]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].args).toEqual(["a", "b"]);
  });
});
