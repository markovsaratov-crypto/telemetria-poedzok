import { describe, it, expect } from "vitest";
import { haversineM } from "../src/lib/geo";

describe("haversineM (§2 базовые формулы)", () => {
  it("нулевая дистанция на одинаковых точках", () => {
    expect(haversineM(55.75, 37.61, 55.75, 37.61)).toBe(0);
  });

  it("known pair: ~111 км на 1° широты", () => {
    const d = haversineM(55, 37, 56, 37);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("known pair: Москва→Питер ≈ 600+ км", () => {
    const d = haversineM(55.7558, 37.6173, 59.9343, 30.3351);
    expect(d).toBeGreaterThan(600_000);
    expect(d).toBeLessThan(700_000);
  });

  it("симметрия d(a,b) = d(b,a)", () => {
    const a = haversineM(55.1, 37.2, 55.3, 37.9);
    const b = haversineM(55.3, 37.9, 55.1, 37.2);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
});
