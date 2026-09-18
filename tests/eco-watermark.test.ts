// tests/eco-watermark.test.ts — v2.40.3 (ревью 19-j): персист watermark корпуса.
// Проверяют: (1) round-trip сериализации Map → Setting-JSON → Map (значения
// тождественны, включая null-rates «ниже gate <60»); (2) устойчивость к битому
// JSON / чужому формату / некорректным типам — deserialize возвращает null или
// выбрасывает только ВАЛИДНЫЕ записи; (3) isD1QuotaError закрывает R-7 (тестов
// не было): оба варианта лимита (read/write), не-Error, не-совпадающий текст.
import { describe, it, expect } from "vitest";
import { isD1QuotaError } from "../src/lib/db";
import {
  serializeWatermark,
  deserializeWatermark,
} from "../src/lib/eco-corpus-watermark";

describe("eco-corpus watermark персист (v2.40.3, рестарт-бёрн)", () => {
  it("round-trip: rates и null-rates пер-сессий тождественны", () => {
    const wm = new Map<
      string,
      { rates: { braking: number; accel: number; jerk: number } | null; pointCount: number }
    >([
      ["sess-a", { rates: { braking: 0.12, accel: 0.34, jerk: 0.56 }, pointCount: 1234 }],
      ["sess-b", { rates: null, pointCount: 59 }], // ниже gate <60 — не калибрует
      ["sess-c", { rates: { braking: 0.01, accel: 0.02, jerk: 0.03 }, pointCount: 80 }],
    ]);
    const json = serializeWatermark(wm);
    const back = deserializeWatermark(json);
    expect(back).not.toBeNull();
    expect(back!.size).toBe(3);
    expect(back!.get("sess-a")).toEqual({
      rates: { braking: 0.12, accel: 0.34, jerk: 0.56 },
      pointCount: 1234,
    });
    expect(back!.get("sess-b")).toEqual({ rates: null, pointCount: 59 });
  });

  it("битый JSON / чужой формат / NaN-точки → null либо чистый Map", () => {
    expect(deserializeWatermark("not-json{{")).toBeNull();
    expect(deserializeWatermark(JSON.stringify({ v: 2, wm: {} }))).toBeNull();
    expect(deserializeWatermark(JSON.stringify(null))).toBeNull();
    // некорректные записи отбрасываются ПОШТУЧНО (валидные выживают)
    const partial = deserializeWatermark(
      JSON.stringify({
        v: 1,
        wm: {
          ok: { r: [0.1, 0.2, 0.3], pc: 100 },
          bad_pc: { r: [0.1, 0.2, 0.3], pc: "many" },
          bad_rates: { r: [0.1, "x", 0.3], pc: 50 },
        },
      })
    );
    expect(partial).not.toBeNull();
    expect(partial!.has("ok")).toBe(true);
    expect(partial!.has("bad_pc")).toBe(false);
    // bad_rates: pc валиден → запись живёт с rates=null (сessor как «ниже gate»)
    expect(partial!.get("bad_rates")).toEqual({ rates: null, pointCount: 50 });
  });

  it("isD1QuotaError (R-7): оба лимита читаются, прочие строки — нет", () => {
    expect(
      isD1QuotaError(new Error("D1_ERROR: You have exceeded D1's free tier daily row read limit."))
    ).toBe(true);
    expect(
      isD1QuotaError(new Error("exceeded D1's free tier daily row write limit"))
    ).toBe(true);
    expect(isD1QuotaError(new Error("some other D1_ERROR"))).toBe(false);
    expect(isD1QuotaError("exceeded D1's free tier daily row read limit")).toBe(false); // не Error
    expect(isD1QuotaError(null)).toBe(false);
    expect(
      isD1QuotaError(new Error("you have exceeded d1's free tier daily row READ limit")) // регистр
    ).toBe(true);
  });
});
