// tests/stats-rollup.test.ts — v2.39.0 (§A1, docs/OPTIMIZATION-PROPOSAL.md):
// юнит-тесты ЧИСТЫХ функций дневных rollup-агрегатов (dayKey в TZ оператора,
// границы дня, перечисление диапазона, скоуп-ключи, полнота-сверка). БД/сеть
// не задействованы: SQL-ветки (read/bump/recompute) — интеграционный контур
// прод-D1, консервативность их ошибок зафиксирована контрактом fallback.
import { describe, it, expect } from "vitest";
import type { DataScope } from "../src/lib/scope";
import {
  localDayKey,
  dayStartUtcMs,
  enumerateDays,
  rollupUserId,
  rollupIsUsable,
  type RollupSummary,
} from "../src/lib/stats-rollup";

const ms = (iso: string) => Date.parse(iso);

describe("§A1 localDayKey — дневной бакет в TZ оператора", () => {
  it("Europe/Saratov (UTC+4, без DST): полночь UTC = 04:00 местного, тот же день", () => {
    expect(localDayKey(ms("2026-09-18T00:30:00Z"), "Europe/Saratov")).toBe("2026-09-18");
  });

  it("Europe/Saratov: 21:30 UTC = 01:30 следующего дня (переход через полночь)", () => {
    expect(localDayKey(ms("2026-09-18T21:30:00Z"), "Europe/Saratov")).toBe("2026-09-19");
  });

  it("UTC: 23:59:59 остаётся своим днём", () => {
    expect(localDayKey(ms("2026-09-18T23:59:59Z"), "UTC")).toBe("2026-09-18");
  });

  it("America/New_York (DST, UTC−4 летом): 02:00 UTC = 22:00 предыдущего дня", () => {
    expect(localDayKey(ms("2026-07-01T02:00:00Z"), "America/New_York")).toBe("2026-06-30");
  });

  it("формат ключа — строгий YYYY-MM-DD", () => {
    expect(localDayKey(ms("2026-09-18T12:00:00Z"), "UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("§A1 dayStartUtcMs — полночь дня в TZ (граница [start, start+24h))", () => {
  it("UTC: полночь без смещения", () => {
    expect(dayStartUtcMs("2026-09-18", "UTC")).toBe(ms("2026-09-18T00:00:00Z"));
  });

  it("Europe/Saratov: полночь местного = 20:00 UTC предыдущего дня", () => {
    expect(dayStartUtcMs("2026-09-18", "Europe/Saratov")).toBe(ms("2026-09-17T20:00:00Z"));
  });

  it("America/New_York летом: полночь местного = 04:00 UTC того же дня", () => {
    expect(dayStartUtcMs("2026-07-01", "America/New_York")).toBe(ms("2026-07-01T04:00:00Z"));
  });
});

describe("§A1.7 enumerateDays — диапазон дней включительно", () => {
  it("три дня → три ключа по календарю", () => {
    expect(enumerateDays("2026-09-01", "2026-09-03")).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("один день → один ключ", () => {
    expect(enumerateDays("2026-09-01", "2026-09-01")).toEqual(["2026-09-01"]);
  });

  it("инвертированный диапазон → пусто (бэкфилл-лимит 92 дня не обходится)", () => {
    expect(enumerateDays("2026-09-03", "2026-09-01")).toEqual([]);
  });

  it("битые даты → пусто, не бросает", () => {
    expect(enumerateDays("garbage", "2026-09-03")).toEqual([]);
    expect(enumerateDays("2026-09-01", "")).toEqual([]);
  });

  it("92 дня (лимит backfill-rollup) → ровно 92 ключа", () => {
    expect(enumerateDays("2026-06-19", "2026-09-18")).toHaveLength(92);
  });
});

describe("§A1 rollupUserId — скоуп → строковый PK-ключ ('' = unclaimed)", () => {
  it("own → String(userId)", () => {
    expect(rollupUserId({ mode: "own", userId: "usr-1" })).toBe("usr-1");
  });

  it("own с null userId (нештатный рантайм-скоп) → sentinel '' — модуль обороняется «?? ''»", () => {
    // тип DataScope описывает userId?: string; null приходит только из внешнего
    // JSON/кэша — потому явный каст, рантайм-поведение фиксировано тестом
    expect(rollupUserId({ mode: "own", userId: null } as unknown as DataScope)).toBe("");
  });

  it("unclaimed → ''", () => {
    expect(rollupUserId({ mode: "unclaimed" })).toBe("");
  });

  it("all → '' (суммируются строки всех владельцев)", () => {
    expect(rollupUserId({ mode: "all" })).toBe("");
  });
});

describe("§A1.4 rollupIsUsable — полнота-сверка перед доверием SUM(points)", () => {
  const base: RollupSummary = {
    sessions: 42,
    points: 10_000,
    maxUpdatedAt: ms("2026-09-18T12:00:00Z"),
    recentDays: [],
  };

  it("null (rollup недоступен/выключен) → false — вызывающий фолбэчится", () => {
    expect(rollupIsUsable(null, 42, 0)).toBe(false);
  });

  it("сессии совпали, свежесть ок → true", () => {
    expect(rollupIsUsable(base, 42, ms("2026-09-18T11:59:00Z"))).toBe(true);
  });

  it("пропущен день (SUM(sessions) < COUNT(Session)) → false", () => {
    expect(rollupIsUsable(base, 43, 0)).toBe(false);
  });

  it("инкремент потерян (rollup старее последнего Session.updatedAt) → false", () => {
    expect(rollupIsUsable(base, 42, ms("2026-09-18T12:00:01Z"))).toBe(false);
  });

  it("пустая БД сессий (count 0) при пустой таблице rollup → true (0 = честный 0)", () => {
    const empty: RollupSummary = { sessions: 0, points: 0, maxUpdatedAt: 0, recentDays: [] };
    expect(rollupIsUsable(empty, 0, 0)).toBe(true);
  });

  it("maxSessionUpdatedAt = 0 (нет данных) → проверка свежести пропускается", () => {
    expect(rollupIsUsable(base, 42, 0)).toBe(true);
  });
});
