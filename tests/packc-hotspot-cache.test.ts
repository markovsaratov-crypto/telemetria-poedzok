// tests/packc-hotspot-cache.test.ts — v2.40.9 (Pack C, N-7): персистентный
// кэш heavy-segments. Слои: in-memory LRU (тестируется напрямую), KV шлюза
// (контракт — в воркере; клиент деградирует в compute — источник "error").
// Инварианты: watermark меняется от состава групп/периода/tz/версии конвейера;
// повтор в пределах TTL = cache:"memory" без повторного compute; смена
// watermark = честный пересчёт; oversized payload не кэшируется.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  hotspotWatermark,
  cachedHotspotResponse,
  resetHotspotCacheForTests,
} from "../src/lib/routes-hotspot-cache";
import { SESSION_CACHE_VERSION } from "../src/lib/session-cache";

describe("§C N-7: watermark — сигнатура состава групп", () => {
  it("детерминирован для одного состава", () => {
    const parts = ["r1:5:2026-09-20T10:00:00Z", "r2:3:2026-09-19T09:00:00Z", "period:week"];
    expect(hotspotWatermark(parts)).toBe(hotspotWatermark([...parts]));
  });
  it("новая сессия в группе (sessionCount/lastSeen) → ДРУГОЙ watermark", () => {
    const before = ["r1:5:2026-09-20T10:00:00Z"];
    const after = ["r1:6:2026-09-20T12:00:00Z"];
    expect(hotspotWatermark(before)).not.toBe(hotspotWatermark(after));
  });
  it("порядок групп не меняет watermark (сортировка канона)", () => {
    const a = ["r1:5:t1", "r2:3:t2"];
    const b = ["r2:3:t2", "r1:5:t1"];
    expect(hotspotWatermark(a)).toBe(hotspotWatermark(b));
  });
  it("период/tz/версия кэша сессий входят в подпись", () => {
    const base = ["r1:5:t1"];
    expect(hotspotWatermark(base)).not.toBe(hotspotWatermark([...base, "period:today"]));
    expect(hotspotWatermark(base)).not.toBe(hotspotWatermark([...base, "tz:-240"]));
    expect(hotspotWatermark(base)).not.toBe(hotspotWatermark([...base, `scv:${SESSION_CACHE_VERSION + 1}`]));
  });
  it("склейки разных списков не совпадают (разделитель частей)", () => {
    expect(hotspotWatermark(["ab", "c"])).not.toBe(hotspotWatermark(["a", "bc"]));
  });
});

describe("§C N-7: cachedHotspotResponse — слои и честность", () => {
  beforeEach(() => resetHotspotCacheForTests());
  afterEach(() => vi.restoreAllMocks());

  it("первый вызов = compute, повтор в TTL = memory БЕЗ повторного compute", async () => {
    const compute = vi.fn(async () => ({ groups: [{ routeHash: "r1" }] }));
    const parts = ["r1:5:t1", "period:all"];
    const first = await cachedHotspotResponse(["owner", "all", "0"], parts, compute);
    expect(first.cache).not.toBe("memory"); // холодный (KV выключен вне D1 → error/miss)
    expect(compute).toHaveBeenCalledTimes(1);
    const second = await cachedHotspotResponse(["owner", "all", "0"], parts, compute);
    expect(second.cache).toBe("memory"); // слой 1 накрыл
    expect(second.data).toEqual(first.data);
    expect(compute).toHaveBeenCalledTimes(1); // compute НЕ звался повторно
  });

  it("смена watermark = ДРУГОЙ ключ = честный пересчёт", async () => {
    const compute = vi.fn(async () => ({ v: 1 }));
    await cachedHotspotResponse(["owner", "all", "0"], ["r1:5:t1"], compute);
    const next = await cachedHotspotResponse(["owner", "all", "0"], ["r1:6:t2"], compute);
    expect(next.cache).not.toBe("memory"); // новая сигнатура — холодный путь
    expect(compute).toHaveBeenCalledTimes(2);
    expect(next.watermark).not.toBe(hotspotWatermark(["r1:5:t1"]));
  });

  it("другой scope/period/tz = другой ключ (изоляция данных)", async () => {
    const compute = vi.fn(async () => ({ x: 1 }));
    await cachedHotspotResponse(["owner", "all", "0"], ["r1:5:t1"], compute);
    const other = await cachedHotspotResponse(["user-42", "all", "0"], ["r1:5:t1"], compute);
    expect(other.cache).not.toBe("memory");
    const otherPeriod = await cachedHotspotResponse(["owner", "today", "0"], ["r1:5:t1"], compute);
    expect(otherPeriod.cache).not.toBe("memory");
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("oversized payload (>512 КБ) не кэшируется — каждый вызов честный compute", async () => {
    const big = { blob: "x".repeat(600_000) };
    const compute = vi.fn(async () => big);
    const r1 = await cachedHotspotResponse(["k"], ["p"], compute);
    const r2 = await cachedHotspotResponse(["k"], ["p"], compute);
    expect(r1.cache).not.toBe("memory");
    expect(r2.cache).not.toBe("memory");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("ошибка compute пробрасывается (кэш не глотает сбои конвейера)", async () => {
    const compute = vi.fn(async () => {
      throw new Error("pipeline failed");
    });
    await expect(cachedHotspotResponse(["k"], ["p"], compute)).rejects.toThrow("pipeline failed");
  });
});
