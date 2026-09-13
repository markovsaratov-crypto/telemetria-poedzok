import { describe, it, expect } from "vitest";
import { medianSmooth3, medianOf, rejectSpeedOutliersByDisplacement } from "../src/lib/kpi";

describe("kpi: медианные фильтры (робастность сырых GPS-скоростей)", () => {
  it("medianOf: нечётная выборка — центральный элемент", () => {
    expect(medianOf([1, 3, 5])).toBe(3);
  });

  it("medianOf: чётная выборка — среднее двух центральных (вход отсортирован)", () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  it("medianSmooth3 гасит одиночный импульс (stale-fix скачок скорости)", () => {
    // прод-кейс e37f9a78: 0 → 58 км/ч... в м/с: спайк 58 м/с между ~16 м/с
    const speeds = [16, 16, 16.1, 16.05, 16, 16.2, 16.1];
    const baseline = medianSmooth3(speeds);
    speeds[3] = 58; // импульс
    const smoothed = medianSmooth3(speeds);
    const base3 = baseline[3] ?? 0;
    const smooth3 = smoothed[3] ?? 0;
    expect(Math.abs(smooth3 - base3)).toBeLessThan(1);
    expect(smooth3).toBeLessThan(20);
  });

  it("medianSmooth3 сохраняет честную ступеньку (разгон — не импульс)", () => {
    // 0,0,0,20,20,20: ступенька в 20 — реальный разгон из idle
    const smoothed = medianSmooth3([0, 0, 0, 20, 20, 20]);
    expect(smoothed[2]).toBe(0);  // медиана окна (0,0,0)
    expect(smoothed[5]).toBe(20); // медиана окна (20,20,20)
  });

  it("rejectSpeedOutliersByDisplacement: спайк, опровергаемый геометрией с обеих сторон, замещается", () => {
    // точка стоит на месте (позиция не меняется), но speed = 38 м/с (137 км/ч —
    // прод-кейс 173b5354 на парковке). Обе стороны опровергают → замещение
    // геометрической скоростью (≈0).
    const pts = [
      { lat: 55.0, lon: 37.0, speed: 0.5, timestamp: 1_000_000, altitude: null, bearing: null, accuracy: 3 },
      { lat: 55.0, lon: 37.0, speed: 38.0, timestamp: 1_001_000, altitude: null, bearing: null, accuracy: 3 },
      { lat: 55.0, lon: 37.0, speed: 0.5, timestamp: 1_002_000, altitude: null, bearing: null, accuracy: 3 },
    ];
    const out = rejectSpeedOutliersByDisplacement(pts);
    expect(out[1].speed).toBeLessThan(1);
  });

  it("rejectSpeedOutliersByDisplacement: честный разгон не трогает", () => {
    // 0 → 20 м/с: следующая секунда пути ~10 м → v_impl ≈ 10 → 20 < 10×3+3 ✓
    const pts = [
      { lat: 55.0,        lon: 37.0, speed: 0,  timestamp: 1_000_000, altitude: null, bearing: null, accuracy: 3 },
      { lat: 55.0,        lon: 37.0, speed: 20, timestamp: 1_001_000, altitude: null, bearing: null, accuracy: 3 },
      { lat: 55.00009,    lon: 37.0, speed: 20, timestamp: 1_002_000, altitude: null, bearing: null, accuracy: 3 }, // ~10 м пути
    ];
    const out = rejectSpeedOutliersByDisplacement(pts);
    expect(out[1].speed).toBe(20);
  });
});
