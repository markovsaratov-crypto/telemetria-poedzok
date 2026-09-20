// tests/teleport-guard.test.ts — v2.40.7 (N-3 «GPS-телепорт»): физический
// инвариант интервала d/dt ≤ 200 км/ч на всех путях интеграции дистанции.
//
// Прод-кейс 20.09 (записи 920ff881/92cf1bc1): ZIP-импорт принёс прыжки
// Саратов→Казахстан 890 км за 449 с (1 982 м/с) и обратно 885 км за 616 с.
// Гаверсинус суммировал их в дистанцию, sparse-move §4.6а (без потолка)
// пропускал как «движение», leg растягивался на телепорт, gapTime = 0:
// период 14–20.09 показывал «2 435,1 км, средняя 387,3 км/ч при макс. 179,3».
import { describe, it, expect } from "vitest";
import { plausibleIntervalM, isTeleportInterval, haversineM } from "../src/lib/geo";
import { computeMovingTime } from "../src/lib/active-trip";
import { computeSessionStats } from "../src/lib/session-stats";
import { computeSessionTrack } from "../src/lib/session-track";
import { normalizeSessionSpeeds } from "../src/lib/kpi";
import type { MethodologyPoint } from "../src/lib/active-trip";

const SARATOV = { lat: 51.5, lon: 46.0 };
const KAZAKHSTAN = { lat: 49.73, lon: 58.28 }; // ~890 км от Саратова

function pt(
  base: { lat: number; lon: number },
  tSec: number,
  speed: number | null = 10,
  accuracy: number | null = 5
): MethodologyPoint {
  return { ...base, speed, altitude: null, bearing: null, accuracy, timestamp: tSec * 1000 };
}

describe("geo: plausibleIntervalM / isTeleportInterval (N-3)", () => {
  it("правдоподобный интервал (15 м/с) проходит целиком", () => {
    // 15 м/с за 1 с → ~15 м пути; строим реальные координаты
    const dLat = (15 / 111_320); // ~15 м на север
    const d = plausibleIntervalM(SARATOV.lat, SARATOV.lon, SARATOV.lat + dLat, SARATOV.lon, 1);
    expect(d).toBeGreaterThan(13);
    expect(d).toBeLessThan(16);
    expect(isTeleportInterval(SARATOV.lat, SARATOV.lon, SARATOV.lat + dLat, SARATOV.lon, 1)).toBe(false);
  });

  it("телепорт 890 км за 449 с — 0 метров (v_impl = 1 982 м/с)", () => {
    const d = plausibleIntervalM(SARATOV.lat, SARATOV.lon, KAZAKHSTAN.lat, KAZAKHSTAN.lon, 449);
    expect(d).toBe(0);
    expect(isTeleportInterval(SARATOV.lat, SARATOV.lon, KAZAKHSTAN.lat, KAZAKHSTAN.lon, 449)).toBe(true);
  });

  it("dt ≤ 0 (дубликат timestamp с прыжком позиции) — телепорт", () => {
    expect(plausibleIntervalM(SARATOV.lat, SARATOV.lon, KAZAKHSTAN.lat, KAZAKHSTAN.lon, 0)).toBe(0);
    expect(isTeleportInterval(SARATOV.lat, SARATOV.lon, KAZAKHSTAN.lat, KAZAKHSTAN.lon, -5)).toBe(true);
  });

  it("разреженное движение §4.6а (3,4 км за 360 с = 9,4 м/с) проходит", () => {
    const dLat = 3400 / 111_320;
    const d = plausibleIntervalM(SARATOV.lat, SARATOV.lon, SARATOV.lat + dLat, SARATOV.lon, 360);
    expect(d).toBeGreaterThan(3300);
    expect(d).toBeLessThan(3500);
  });

  it("vMaxMs настраивается (.guard для экзотики вроде поездов)", () => {
    // 90 м/с (324 км/ч) за 1 с: стандартный потолок режет, кастомный пропускает
    const dLat = 90 / 111_320;
    expect(plausibleIntervalM(SARATOV.lat, SARATOV.lon, SARATOV.lat + dLat, SARATOV.lon, 1)).toBe(0);
    expect(plausibleIntervalM(SARATOV.lat, SARATOV.lon, SARATOV.lat + dLat, SARATOV.lon, 1, 100)).toBeGreaterThan(80);
  });
});

describe("active-trip: sparse-move получает потолок правдоподобия (N-3)", () => {
  it("телепорт-интервал = честный gap (gapTime растёт, moving не растёт)", () => {
    const pts: MethodologyPoint[] = [
      pt(SARATOV, 0, 10),
      pt({ lat: SARATOV.lat + 0.0001, lon: SARATOV.lon }, 1, 10), // движение
      pt(KAZAKHSTAN, 450, 10), // телепорт: 890 км за 449 с
      pt(SARATOV, 1066, 10), // обратный телепорт
      pt({ lat: SARATOV.lat + 0.0002, lon: SARATOV.lon }, 1067, 10),
    ];
    const m = computeMovingTime(pts);
    expect(m.gapTime).toBeGreaterThanOrEqual(449 + 615); // оба телепорта — gap
    expect(m.states[1]).toBe("gap"); // интервал 1→2 (телепорт туда)
    expect(m.states[2]).toBe("gap"); // интервал 2→3 (телепорт обратно)
  });

  it("легитимный блип §4.6а (3,4 км, 6 мин тишины) остаётся движением", () => {
    const dLat = 3400 / 111_320;
    const pts: MethodologyPoint[] = [
      pt({ lat: SARATOV.lat, lon: SARATOV.lon }, 0, 12),
      pt({ lat: SARATOV.lat + dLat, lon: SARATOV.lon }, 360, 12), // 9,4 м/с средняя
      pt({ lat: SARATOV.lat + 2 * dLat, lon: SARATOV.lon }, 720, 12),
    ];
    const m = computeMovingTime(pts);
    expect(m.movingTime).toBe(720); // всё — движение (блипы подтверждаются)
    expect(m.gapTime).toBe(0);
  });
});

describe("session-stats: дистанция не интегрирует телепорты (N-3)", () => {
  // 100 сек честного движения по ~10 м/с + телепорт туда-обратно
  function buildSession(withTeleport: boolean): MethodologyPoint[] {
    const pts: MethodologyPoint[] = [];
    const stepLat = 10 / 111_320; // ~10 м/с на север
    for (let i = 0; i <= 100; i++) {
      pts.push(pt({ lat: SARATOV.lat + i * stepLat, lon: SARATOV.lon }, i, 10, 5));
    }
    if (withTeleport) {
      // вставляем 2 точки «в Казахстане» с дырами по 449/616 с (как в 920ff881)
      const i = pts.length;
      pts.push({ ...KAZAKHSTAN, speed: 4.5, altitude: null, bearing: null, accuracy: 15, timestamp: (i + 449) * 1000 });
      pts.push({ lat: 49.7305, lon: 58.2790, speed: 4.5, altitude: null, bearing: null, accuracy: 15, timestamp: (i + 450) * 1000 });
      pts.push({ ...SARATOV, speed: 4.5, altitude: null, bearing: null, accuracy: 15, timestamp: (i + 450 + 616) * 1000 });
      // хвост движения после возврата
      for (let k = 1; k <= 30; k++) {
        pts.push(pt({ lat: SARATOV.lat + k * stepLat, lon: SARATOV.lon }, i + 450 + 616 + k, 10, 5));
      }
    }
    return pts;
  }

  it("чистая сессия: дистанция ≈ Σ шагов, телепортов 0", () => {
    const res = computeSessionStats({ id: "t1", startTime: new Date(0).toISOString(), endTime: new Date(100_000).toISOString() }, buildSession(false));
    expect(res.kind).toBe("full");
    if (res.kind !== "full") return;
    expect(res.payload.distance).toBeGreaterThan(900); // ~1 км
    expect(res.payload.distance).toBeLessThan(1100);
    expect(res.payload.teleportDistanceM).toBe(0);
    // инвариант: средняя не больше максимума
    const avg = res.payload.avgSpeed ?? 0;
    const max = res.payload.maxSpeed ?? 0;
    expect(avg).toBeLessThanOrEqual(max + 0.5);
  });

  it("сессия с телепортом: 1 775 км фантома срезаны, инвариант avg ≤ max жив", () => {
    const res = computeSessionStats({ id: "t2", startTime: new Date(0).toISOString(), endTime: new Date((100 + 450 + 616 + 30) * 1000).toISOString() }, buildSession(true));
    expect(res.kind).toBe("full");
    if (res.kind !== "full") return;
    // ~1,3 км реального движения — НЕ 1776,9 км
    expect(res.payload.distance).toBeGreaterThan(1000);
    expect(res.payload.distance).toBeLessThan(1600);
    // фантомные метры задокументированы (~890 + ~885 + ~0,6 км)
    expect(res.payload.teleportDistanceM).toBeGreaterThan(1_500_000);
    // средняя физична (≤ 200 км/ч тем более ≤ max+ε)
    const avg = res.payload.avgSpeed ?? 0;
    expect(avg * 3.6).toBeLessThan(200);
    // телепорты — честные gaps
    expect(res.payload.gapTime).toBeGreaterThanOrEqual(449 + 615);
  });
});

describe("session-track: острова телепортов не попадают на карту (N-3)", () => {
  it("bounds не растягиваются на Казахстан; точки кластера выброшены", () => {
    const stepLat = 10 / 111_320;
    const raw: Array<{ lat: number; lon: number; speed: number | null; altitude: number | null; accuracy: number | null; bearing: number | null; timestamp: number }> = [];
    for (let i = 0; i <= 50; i++) raw.push({ lat: SARATOV.lat + i * stepLat, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: i * 1000 });
    // кластер из 2 точек в Казахстане (внутренние интервалы — телепорты)
    raw.push({ ...KAZAKHSTAN, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (50 + 449) * 1000 });
    raw.push({ lat: 49.7305, lon: 58.2790, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (50 + 450) * 1000 });
    raw.push({ ...SARATOV, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (50 + 450 + 616) * 1000 });
    for (let k = 1; k <= 20; k++) raw.push({ lat: SARATOV.lat + k * stepLat, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: (50 + 450 + 616 + k) * 1000 });

    const track = computeSessionTrack({ id: "tr1", deviceId: "d", startTime: new Date(0).toISOString(), endTime: null, pointCount: raw.length }, raw) as Record<string, unknown>;
    const bounds = track.bounds as number[][];
    const [south, west] = bounds[0];
    const [north, east] = bounds[1];
    // Саратов ± ~0,01°: Казахстан (49,73/58,28) выброшен из зума
    expect(south).toBeGreaterThan(49.9);
    expect(north).toBeLessThan(51.7);
    expect(east).toBeLessThan(46.5);
    expect(west).toBeGreaterThan(45.5);
    // 2 точки кластера выброшены из массива точек
    const points = track.points as Array<{ lat: number }>;
    expect(points.length).toBe(raw.length - 2);
    expect(points.some((p) => p.lat < 50)).toBe(false);
  });

  it("БОЛЬШОЙ ран между телепортами — основной трек, не выбрасывается (регрессия 920ff881)", () => {
    // реальный кейс: 862-точечный ран реального движения зажат джиттер-телепортом
    // слева (60 м за 1 с) и КЗ-телепортом справа. Первая версия островов роняла
    // его целиком — карта теряла 14 минут трека.
    const stepLat = 10 / 111_320;
    const raw: Array<{ lat: number; lon: number; speed: number | null; altitude: number | null; accuracy: number | null; bearing: number | null; timestamp: number }> = [];
    for (let i = 0; i <= 40; i++) raw.push({ lat: SARATOV.lat + i * stepLat, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: i * 1000 });
    // джиттер-телепорт (плотный): 60 м за 1 с = 60 м/с > 55,6
    raw.push({ lat: SARATOV.lat + 0.001, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: 41_000 });
    // ОСНОВНОЙ ТРЕК: 300 точек по 10 м/с
    for (let i = 0; i <= 300; i++) raw.push({ lat: SARATOV.lat + 0.001 + i * stepLat, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: (42 + i) * 1000 });
    // КЗ-телепорт из конца трека
    raw.push({ ...KAZAKHSTAN, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (42 + 301 + 449) * 1000 });
    raw.push({ lat: 49.7305, lon: 58.2790, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (42 + 302 + 449) * 1000 });
    // возврат в Саратов + хвост
    raw.push({ ...SARATOV, speed: 4.5, altitude: null, accuracy: 15, bearing: null, timestamp: (42 + 302 + 449 + 616) * 1000 });
    for (let k = 1; k <= 20; k++) raw.push({ lat: SARATOV.lat + k * stepLat, lon: SARATOV.lon, speed: 10, altitude: null, accuracy: 5, bearing: null, timestamp: (42 + 302 + 449 + 616 + k) * 1000 });

    const track = computeSessionTrack({ id: "tr2", deviceId: "d", startTime: new Date(0).toISOString(), endTime: null, pointCount: raw.length }, raw) as Record<string, unknown>;
    const points = track.points as Array<{ lat: number }>;
    // выпали ТОЛЬКО 2 точки КЗ-кластера — основной 300-точечный ран цел
    expect(points.length).toBe(raw.length - 2);
    expect(points.some((p) => p.lat < 50)).toBe(false);
    // и основной ран действительно в массиве: 300+ соседних точек подряд из Саратова
    const saratovRun = points.filter((p) => p.lat > 51.4 && p.lat < 51.55).length;
    expect(saratovRun).toBeGreaterThan(300);
  });
});

describe("kpi: normalizeSessionSpeeds — geoAvg не отравляется телепортом (N-3)", () => {
  it("один телепорт не запускает B-4-пересчёт на согласованном поле speed", () => {
    const stepLat = 10 / 111_320;
    const pts: MethodologyPoint[] = [];
    for (let i = 0; i <= 30; i++) pts.push(pt({ lat: SARATOV.lat + i * stepLat, lon: SARATOV.lon }, i, 10, 5));
    // телепорт (dt 300 c, 890 км) со скоростью 4 м/с
    pts.push({ ...KAZAKHSTAN, speed: 4, altitude: null, bearing: null, accuracy: 15, timestamp: 330 * 1000 });
    pts.push({ ...SARATOV, speed: 4, altitude: null, bearing: null, accuracy: 15, timestamp: (330 + 300) * 1000 });

    const out = normalizeSessionSpeeds(pts);
    // согласованному полю скорость не переписывается (B-4 не сработал: geoAvg
    // без телепорта ≈ 9,8 м/с, медиана 10 ≥ 0,4 × 9,8)
    expect(out[15].speed).toBe(10);
    expect(out[0].speed).toBe(10);
  });
});

describe("N-3: сквозной инвариант прод-кейса 20.09 (воспроизведение цифр)", () => {
  it("агрегат «средняя > максимума» больше не воспроизводится", () => {
    // компактная модель записи 920ff881: 5134 тчк → здесь 200 тчк движения
    // 17 м/с + пара прыжков 890/885 км; до фикса avg = distance/active > max.
    const pts: MethodologyPoint[] = [];
    const stepLat = 17 / 111_320;
    for (let i = 0; i <= 200; i++) pts.push(pt({ lat: SARATOV.lat + i * stepLat, lon: SARATOV.lon }, i, 17, 14));
    pts.push({ ...KAZAKHSTAN, speed: 4.8, altitude: null, bearing: null, accuracy: 15, timestamp: (200 + 449) * 1000 });
    pts.push({ lat: 49.7305, lon: 58.2790, speed: 4.8, altitude: null, bearing: null, accuracy: 15, timestamp: (200 + 450) * 1000 });
    pts.push({ lat: SARATOV.lat + 0.1, lon: SARATOV.lon + 0.05, speed: 4.8, altitude: null, bearing: null, accuracy: 15, timestamp: (200 + 450 + 616) * 1000 });
    for (let k = 1; k <= 100; k++) pts.push(pt({ lat: SARATOV.lat + 0.1 + k * stepLat, lon: SARATOV.lon + 0.05 }, 200 + 450 + 616 + k, 17, 14));

    const res = computeSessionStats({ id: "prod", startTime: new Date(0).toISOString(), endTime: new Date((200 + 450 + 616 + 100) * 1000).toISOString() }, pts);
    expect(res.kind).toBe("full");
    if (res.kind !== "full") return;
    const avg = res.payload.avgSpeed ?? 0;
    const max = res.payload.maxSpeed ?? 0;
    // КЛЮЧЕВОЙ инвариант скрина владельца: 387,3 > 179,3 — больше невозможно
    expect(avg).toBeLessThanOrEqual(max + 0.5);
    expect(avg * 3.6).toBeLessThan(200);
    // и ~1 775 км фантома задокументированы
    expect(res.payload.teleportDistanceM).toBeGreaterThan(1_500_000);
    expect(res.payload.distance).toBeLessThan(10_000);
    // gapTime ≠ 0 (на скрине было «развороты: 0 сек» при 1 065 с дыр)
    expect(res.payload.gapTime).toBeGreaterThan(1000);
  });
});
