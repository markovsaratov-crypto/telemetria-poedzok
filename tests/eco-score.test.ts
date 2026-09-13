import { describe, it, expect } from "vitest";
import { calibrateEcoScoreBaselinesFromCorpus, DEFAULT_BASELINES } from "../src/lib/metrics-methodology";

const rates = (n: number, v = 0.5) =>
  Array.from({ length: n }, () => ({ braking: v, accel: v, jerk: v }));

describe("§7.3 EcoScore — корпусная калибровка CAP-базлайнов", () => {
  it("пустой корпус → дефолты 0.5/0.4/0.3", () => {
    const b = calibrateEcoScoreBaselinesFromCorpus([]);
    expect(b.braking).toBe(DEFAULT_BASELINES.braking);
    expect(b.accel).toBe(DEFAULT_BASELINES.accel);
    expect(b.jerk).toBe(DEFAULT_BASELINES.jerk);
    expect(b.corpusSize).toBe(0);
  });

  it("корпус < 5 сессий → дефолты (маленькая выборка не калибрует)", () => {
    const b = calibrateEcoScoreBaselinesFromCorpus(rates(4));
    expect(b.version).toBe("default");
  });

  it("корпус 5..min-1 → медиана × 1.2 (запас малой выборки)", () => {
    const b = calibrateEcoScoreBaselinesFromCorpus(rates(10, 0.5));
    expect(b.version).toContain("margin");
    expect(b.braking).toBeCloseTo(0.5 * 1.2, 5);
    expect(b.corpusSize).toBe(10);
  });

  it("большой корпус (≥ 30) → чистая медиана без запаса", () => {
    const b = calibrateEcoScoreBaselinesFromCorpus(rates(40, 0.5));
    expect(b.version).toBe("corpus-median-40");
    expect(b.braking).toBeCloseTo(0.5, 5);
  });

  it("медиана, а не среднее — выброс не сдвигает базлайн", () => {
    // 39 сессий по 0.5 + одна аномальная 50.0 → медиана остаётся 0.5
    const corpus = rates(39, 0.5).concat([{ braking: 50, accel: 50, jerk: 50 }]);
    const b = calibrateEcoScoreBaselinesFromCorpus(corpus);
    expect(b.braking).toBeCloseTo(0.5, 5);
  });
});
