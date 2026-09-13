import { describe, it, expect } from "vitest";
import { computeBearingConsistency, computeUTurnCount, computeTurnCount } from "../src/lib/metrics-methodology";
import type { ActiveTrip, MethodologyPoint } from "../src/lib/active-trip";

function makeTrip(startMs: number, endMs: number): ActiveTrip {
  return {
    hasActiveTrip: true,
    activeStartTime: startMs,
    activeEndTime: endMs,
    activeDuration: (endMs - startMs) / 1000,
    spanDuration: (endMs - startMs) / 1000,
    legCount: 1,
    legs: [{
      startTime: startMs,
      endTime: endMs,
      durationSec: (endMs - startMs) / 1000,
      startCoord: { lat: 0, lon: 0 },
      endCoord: { lat: 0, lon: 0 },
    }],
    longestInternalStopSec: 0,
    internalStopTime: 0,
    activeStartCoord: { lat: 0, lon: 0 },
    activeEndCoord: { lat: 0, lon: 0 },
    preTripIdle: 0,
    postTripIdle: 0,
    activeIdleTime: 0,
  };
}

function pts(bearings: Array<number | null>, opts?: { speed?: number; dtMs?: number }): MethodologyPoint[] {
  const dt = opts?.dtMs ?? 1000;
  const v = opts?.speed ?? 10; // м/с = 36 км/ч > 5 км/ч — гейт скорости пройден
  return bearings.map((b, i) => ({
    lat: 55 + i * 0.0001,
    lon: 37,
    speed: b == null ? v : v,
    altitude: null,
    accuracy: 5,
    bearing: b,
    timestamp: 1_000_000 + i * dt,
  }));
}

const T = makeTrip(0, 10_000_000);

describe("§7.7 BearingConsistency — круговая статистика (mean cos signed Δ)", () => {
  it("прямой курс (все Δ=0) → 1.0", () => {
    expect(computeBearingConsistency(pts([90, 90, 90, 90, 90, 90]), T)).toBe(1);
  });

  it("отсутствие активной части → null", () => {
    expect(computeBearingConsistency(pts([90, 90, 90]), { ...T, hasActiveTrip: false })).toBeNull();
  });

  it("менее 2 валидных интервалов → null", () => {
    expect(computeBearingConsistency(pts([90, 90]), T)).toBeNull();
    expect(computeBearingConsistency(pts([null, null, null]), T)).toBeNull();
  });

  it("скорость ≤ 5 км/ч исключает интервал (стояночный bearing шумный)", () => {
    const slow = pts([0, 90, 180], { speed: 1 }); // 3,6 км/ч
    expect(computeBearingConsistency(slow, T)).toBeNull();
  });

  it("wraparound: 359°→1° это поворот на +2°, а не −358°", () => {
    // чередование 359/1: каждый интервал |Δ|=2, sign чередуется ±2
    const v = computeBearingConsistency(pts([359, 1, 359, 1, 359, 1]), T);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(0.99); // почти прямо
  });

  it("КРАЙНИЙ СЛУЧАЙ старой формулы: чередующиеся развороты ±179°", () => {
    // СТАРАЯ формула: свёрнутые дельты [179,179,...] → stddev=0 → 1.0 «идеально
    // прямо» — зигзаг-развроты назывались прямой. Новая: cos(±179°)<0 → кламп 0.
    const v = computeBearingConsistency(pts([0, 179, 0, 179, 0, 179]), T);
    expect(v).toBe(0);
  });

  it("константный резкий поворот (все Δ=179°) → не «прямо»", () => {
    // старая: stddev(179)=0 → 1.0. новая: cos179° < 0 → 0
    const bearings: number[] = [];
    let cur = 0;
    for (let i = 0; i < 6; i++) { bearings.push(cur); cur = (cur + 179) % 360; }
    const v = computeBearingConsistency(pts(bearings), T);
    expect(v).toBe(0);
  });

  it("лёгкая постоянная кривизна (Δ=+3°) остаётся ~1 (локальная прямолинейность)", () => {
    const bearings: number[] = [];
    let cur = 0;
    for (let i = 0; i < 12; i++) { bearings.push(cur); cur = (cur + 3) % 360; }
    const v = computeBearingConsistency(pts(bearings), T);
    expect(v).toBeGreaterThan(0.99);
  });

  it("случайное рассеяние поворотов гасит индекс", () => {
    // +90, −90, +90, −90: cos(90°)=0 → mean 0
    const v = computeBearingConsistency(pts([0, 90, 0, 90, 0, 90, 0]), T);
    expect(v).toBe(0);
  });

  it("городской профиль: 80% прямо + 20% поворотов 45° ≈ 0.97", () => {
    const bearings: number[] = [];
    let cur = 0;
    for (let i = 0; i < 50; i++) {
      bearings.push(cur);
      if (i % 5 === 4) cur = (cur + 45) % 360; // каждый 5-й интервал — поворот 45°
    }
    const v = computeBearingConsistency(pts(bearings), T) as number;
    expect(v).toBeGreaterThan(0.94);
    expect(v).toBeLessThan(0.99);
  });
});

describe("§7.8/§7.9 UTurnCount / TurnCount — границы порогов", () => {
  it("разворот 180° считается UTurn, не Turn ([0,180,0] = 2 интервала → 2 UTurn)", () => {
    const p = pts([0, 180, 0]);
    expect(computeUTurnCount(p, T)).toBe(2);
    expect(computeTurnCount(p, T)).toBe(0);
  });

  it("поворот 60° — Turn, не UTurn (два интервала → 2 Turn)", () => {
    const p = pts([0, 60, 0]);
    expect(computeUTurnCount(p, T)).toBe(0);
    expect(computeTurnCount(p, T)).toBe(2);
  });

  it("wraparound разворота: 10°→190° это |Δ|=180 (оба интервала)", () => {
    const p = pts([10, 190, 10]);
    expect(computeUTurnCount(p, T)).toBe(2);
  });

  it("медленные интервалы не считаются (speed-гейт)", () => {
    const slow = pts([0, 180, 0], { speed: 1 });
    expect(computeUTurnCount(slow, T)).toBe(0);
  });
});
