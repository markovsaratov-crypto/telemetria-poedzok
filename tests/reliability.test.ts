import { describe, it, expect } from "vitest";
import { computeSessionReliability } from "../src/lib/metrics-methodology";
import { computeMovingTime } from "../src/lib/active-trip";
import type { MethodologyPoint } from "../src/lib/active-trip";

// Фикстуры повторяют прод-кейсы §11.6 (см. v2.31.3–v2.31.5): стояночный дрейф,
// импульсы движения в stop-and-go, дубликат timestamp.
function idlePoint(i: number, driftM: number, speed: number | null = 0): MethodologyPoint {
  // 1 м широты ≈ 111 111 м: сдвиг на driftM метров
  return {
    lat: 55 + (i * driftM) / 111_111,
    lon: 37,
    speed,
    altitude: null,
    accuracy: 3,
    bearing: null,
    timestamp: 1_000_000 + i * 1000,
  };
}

describe("§11.6 SessionReliability — дрейф только в настоящем idle", () => {
  it("идеальная стоянка (0 м дрейфа, speed=0) → driftScore = 1", () => {
    const pts = Array.from({ length: 20 }, (_, i) => idlePoint(i, 0, 0));
    const motion = computeMovingTime(pts);
    const r = computeSessionReliability(pts, 1, motion);
    expect(r.driftScore).toBeGreaterThan(0.9);
  });

  it("пустой набор стационарных интервалов → нейтральный 1.0 (не NaN → unreliable)", () => {
    // все точки движутся — стационарных интервалов нет
    const pts = Array.from({ length: 20 }, (_, i) => idlePoint(i, 5, 15));
    const motion = computeMovingTime(pts);
    const r = computeSessionReliability(pts, 1, motion);
    expect(r.driftScore).not.toBeNull();
    expect(Number.isNaN(r.driftScore as number)).toBe(false);
  });

  it("импульс движения в stop-and-go НЕ считается дрейфом (записанная скорость ≥ 1 м/с)", () => {
    // v2.31.5 прод-кейс: интервалы с физическим перемещением 4–8 м при
    // записанной скорости 4–8 м/с. Старый код: P95 «дрейфа» 5–11 м при
    // avgAcc 2–3 м → driftScore=0 → «unreliable» у 15 из 32 записей.
    const pts: MethodologyPoint[] = [];
    for (let i = 0; i < 40; i++) {
      // чередуем: чистый idle (дрейф 0 м) и «ползание» 6 м с speed 6 м/с
      const crawl = i % 2 === 1;
      pts.push(idlePoint(i, crawl ? 6 : 0, crawl ? 6 : 0));
    }
    const motion = computeMovingTime(pts);
    const r = computeSessionReliability(pts, 1, motion);
    expect(r.driftScore).toBeGreaterThan(0.5);
  });

  it("систематический дрейф на стоянке (12 м при accuracy 3 м) → низкий driftScore", () => {
    const pts = Array.from({ length: 30 }, (_, i) => idlePoint(i, 12, 0));
    const motion = computeMovingTime(pts);
    const r = computeSessionReliability(pts, 1, motion);
    expect(r.driftScore).not.toBeNull();
    expect(r.driftScore as number).toBeLessThan(0.5);
  });

  it("менее 2 точек → insufficient_data", () => {
    const r = computeSessionReliability([idlePoint(0, 0)], 1, computeMovingTime([idlePoint(0, 0)]));
    expect(r.rating).toBe("insufficient_data");
  });
});
