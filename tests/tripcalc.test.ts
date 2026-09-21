// tests/tripcalc.test.ts — v2.42.0 «Вариант 1»: промежуточное хранение
// расчётов финальных записей (> 24 ч) — таблица TripCalc.
//
// Инварианты (канон сьютов: чистые функции, БД/сеть не задействованы —
// SQL-ветки — интеграционный контур прод-D1, консервативность их ошибок
// зафиксирована контрактом fallback):
//   1. Финальность: только закрытые > 24 ч и не удалённые записи.
//   2. Обслуживание из снапшота: штамп конвейера ПО ПОЛЯМ + потолок
//      рендера + состав точек (N-8-конвенция — «лжесвежесть» исключена).
//   3. Поле-scoped UPSERT: track-ветка НЕ затирает eventsJson/mетрики
//      (COALESCE-мердж) и наоборот.
//   4. РЕГРЕССИЯ квоты N-6: бамп ОДНОГО конвейера не инвалидирует чужие
//      поля снапшота (сервис трека продолжает жить из снапшота при
//      протухшем statsV).
//   5. Purge: снапшот удаляется чанками ≤ 90 id.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TRIP_CALC_MIN_AGE_MS,
  sessionIsFinalForCalc,
  tripCalcServesTrack,
  tripCalcServesEvents,
  metricsFromStatsResult,
  buildTripCalcUpserts,
  buildTripCalcDeleteStatements,
  tripCalcScopeSql,
  tripCalcStatus,
  resetTripCalcEnsureForTests,
  type TripCalcRow,
  type TripCalcWrite,
} from "../src/lib/trip-calc";

// ——— синтетика ———
const NOW = 1_770_000_000_000; // фикс. «сейчас»
const day = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

const FINAL_META = { endTime: day(TRIP_CALC_MIN_AGE_MS + 60_000), deleted: false, pointCount: 5132 };
const YOUNG_META = { endTime: day(TRIP_CALC_MIN_AGE_MS - 60_000), deleted: false, pointCount: 100 };
const RECORDING_META = { endTime: null, deleted: false, pointCount: 42 };

function baseRow(over: Partial<TripCalcRow> = {}): TripCalcRow {
  return {
    sessionId: "sess-920ff881",
    userId: "533778be",
    day: "2026-09-20",
    final: 1,
    statsCacheV: 2,
    eventsCacheV: 1,
    trackCacheV: 2,
    renderMaxPoints: 400,
    pointCount: 5132,
    distanceM: 118_200,
    durationSec: 6_600,
    avgSpeedMs: 21.9,
    maxSpeedMs: 38,
    ecoScore: 71.5,
    teleportDistanceM: 1_776_480,
    trackJson: '{"points":[1,2,3]}',
    eventsJson: '{"maneuvers":[]}',
    ...over,
  };
}

// ——— §1 финальность ———

describe("«Вариант 1» §1 sessionIsFinalForCalc — порог 24 ч", () => {
  it("закрыта > 24 ч → финальна", () => {
    expect(sessionIsFinalForCalc(FINAL_META.endTime, false, NOW)).toBe(true);
  });

  it("закрыта < 24 ч → НЕ финальна (расчёты ещё меняются)", () => {
    expect(sessionIsFinalForCalc(YOUNG_META.endTime, false, NOW)).toBe(false);
  });

  it("ровно на границе 24 ч → финальна (>=)", () => {
    expect(sessionIsFinalForCalc(day(TRIP_CALC_MIN_AGE_MS), false, NOW)).toBe(true);
  });

  it("граничная-1 мс → НЕ финальна", () => {
    expect(sessionIsFinalForCalc(day(TRIP_CALC_MIN_AGE_MS - 1), false, NOW)).toBe(false);
  });

  it("recording (endTime null) → НЕ финальна", () => {
    expect(sessionIsFinalForCalc(null, false, NOW)).toBe(false);
  });

  it("удалённая → НЕ финальна (снапшот не обслуживает)", () => {
    expect(sessionIsFinalForCalc(FINAL_META.endTime, true, NOW)).toBe(false);
  });

  it("битая дата → НЕ финальна (без исключений)", () => {
    expect(sessionIsFinalForCalc("not-a-date", false, NOW)).toBe(false);
  });
});

// ——— §2 решения об обслуживании ———

describe("«Вариант 1» §2 tripCalcServesTrack — инварианты свежести", () => {
  it("свежий снапшот с тем же потолком → обслуживает", () => {
    expect(tripCalcServesTrack(baseRow(), FINAL_META, 400, 2, NOW)).toBe(true);
  });

  it("другой потолок рендера (400 vs 800) → НЕ обслуживает (нужна своя форма)", () => {
    expect(tripCalcServesTrack(baseRow(), FINAL_META, 800, 2, NOW)).toBe(false);
  });

  it("штамп конвейера трека протух (bump track 2→3) → НЕ обслуживает", () => {
    expect(tripCalcServesTrack(baseRow({ trackCacheV: 1 }), FINAL_META, 400, 2, NOW)).toBe(false);
  });

  it("pointCache разошёлся (точки пришли) → НЕ обслуживает", () => {
    expect(tripCalcServesTrack(baseRow({ pointCount: 5133 }), FINAL_META, 400, 2, NOW)).toBe(false);
  });

  it("строки нет / payload нет → НЕ обслуживает", () => {
    expect(tripCalcServesTrack(undefined, FINAL_META, 400, 2, NOW)).toBe(false);
    expect(tripCalcServesTrack(baseRow({ trackJson: null }), FINAL_META, 400, 2, NOW)).toBe(false);
  });

  it("запись стала моложе порога к моменту чтения → НЕ обслуживает (перестраховка)", () => {
    expect(tripCalcServesTrack(baseRow(), YOUNG_META, 400, 2, NOW)).toBe(false);
  });
});

describe("«Вариант 1» §2 tripCalcServesEvents", () => {
  it("свежий штамп событий → обслуживает (капы фиксированы, потолка нет)", () => {
    expect(tripCalcServesEvents(baseRow(), FINAL_META, 1, NOW)).toBe(true);
  });

  it("штамп событий протух → НЕ обслуживает", () => {
    expect(tripCalcServesEvents(baseRow({ eventsCacheV: 0 }), FINAL_META, 1, NOW)).toBe(false);
  });

  it("eventsJson отсутствует → НЕ обслуживает", () => {
    expect(tripCalcServesEvents(baseRow({ eventsJson: null }), FINAL_META, 1, NOW)).toBe(false);
  });
});

// ——— §3/§4 поле-scoped UPSERT + регрессия N-6 ———

describe("«Вариант 1» §3 buildTripCalcUpserts — COALESCE-мердж полей", () => {
  const baseWrite: TripCalcWrite = {
    sessionId: "sess-a",
    userId: "533778be",
    startTime: "2026-09-20T01:00:00.000Z",
    pointCount: 100,
  };

  it("track-ветка: NULL-метрики/events не пишутся — SQL несёт COALESCE-мердж", () => {
    const stmts = buildTripCalcUpserts([
      { ...baseWrite, trackJson: '{"points":[1]}', renderMaxPoints: 400 },
    ]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain("ON CONFLICT(sessionId) DO UPDATE SET");
    // поле-scoped: чужие поля переживают запись (COALESCE в DO UPDATE)
    expect(stmts[0].sql).toContain("eventsJson = COALESCE(excluded.eventsJson, TripCalc.eventsJson)");
    expect(stmts[0].sql).toContain("trackJson = COALESCE(excluded.trackJson, TripCalc.trackJson)");
    expect(stmts[0].sql).toContain("distanceM = COALESCE(excluded.distanceM, TripCalc.distanceM)");
    // база всегда обновляется (владение/день/состав)
    expect(stmts[0].sql).toContain("pointCount = excluded.pointCount");
    expect(stmts[0].sql).toContain("final = 1");
    // track-ветка несёт ТОЛЬКО свой штамп и потолок
    const args = stmts[0].args as unknown[];
    expect(args[4]).toBeNull(); // statsCacheV
    expect(args[5]).toBeNull(); // eventsCacheV
    expect(args[6]).toBe(2); // trackCacheV (текущий конвейер)
    expect(args[7]).toBe(400); // renderMaxPoints
  });

  it("metrics-ветка: штамп статов + метрики числами", () => {
    const stmts = buildTripCalcUpserts([
      {
        ...baseWrite,
        metrics: {
          distanceM: 118_200,
          durationSec: 6_600,
          avgSpeedMs: 21.9,
          maxSpeedMs: 38,
          ecoScore: 71.5,
          teleportDistanceM: 1_776_480,
        },
      },
    ]);
    expect(stmts).toHaveLength(1);
    // метрики-ветка несёт ТОЛЬКО свой штамп (args: 4=statsV, 8..13 — метрики)
    const args = stmts[0].args as unknown[];
    expect(args[4]).toBe(2); // statsCacheV
    expect(args[8]).toBe(118_200); // distanceM
    expect(args[13]).toBe(1_776_480); // teleportDistanceM
    expect(args[14]).toBeNull(); // eventsJson — не поле этой ветки
    expect(args[15]).toBeNull(); // trackJson
  });

  it("пустая запись (нет ни одного поля) → стейтмента нет", () => {
    expect(buildTripCalcUpserts([baseWrite])).toHaveLength(0);
  });

  it("негабаритный trackJson (>1,5 МБ) → поле пропущено, чужие поля живы", () => {
    const stmts = buildTripCalcUpserts([
      {
        ...baseWrite,
        trackJson: "x".repeat(1_500_001),
        eventsJson: '{"m":[]}',
      },
    ]);
    expect(stmts).toHaveLength(1);
    const args = stmts[0].args as unknown[];
    expect(args[15]).toBeNull(); // trackJson пропущен (гвард гейта 2 МБ)
    expect(args[14]).toBe('{"m":[]}'); // eventsJson пишется
  });

  it("несколько записей → по стейтменту на запись (чанки делает исполнитель)", () => {
    const stmts = buildTripCalcUpserts(
      ["a", "b", "c"].map((id) => ({ ...baseWrite, sessionId: `sess-${id}`, trackJson: "{}" }))
    );
    expect(stmts).toHaveLength(3);
    expect(new Set(stmts.map((s) => s.args[0])).size).toBe(3);
  });
});

// ——— §5 метрики из расчёта ———

describe("«Вариант 1» §5 metricsFromStatsResult — экстракция из payload", () => {
  const full = {
    kind: "full",
    payload: {
      distance: 118_200.4,
      duration: 6_600.7,
      avgSpeed: 21.94,
      maxSpeed: 38.02,
      teleportDistanceM: 1_776_480.3,
      methodology: { ecoScore: { value: 71.484 } },
    },
  };

  it("полный расчёт → метрики округлены (дистанция/длительность/эко 3 зн.)", () => {
    const m = metricsFromStatsResult(full);
    expect(m).not.toBeNull();
    expect(m!.distanceM).toBe(118_200);
    expect(m!.durationSec).toBe(6_601);
    expect(m!.avgSpeedMs).toBe(21.94);
    expect(m!.maxSpeedMs).toBe(38.02);
    expect(m!.ecoScore).toBe(71.484);
    expect(m!.teleportDistanceM).toBe(1_776_480);
  });

  it("kind:empty (запись без точек) → null — метрик нет, слой их не видит", () => {
    expect(metricsFromStatsResult({ kind: "empty", payload: {} })).toBeNull();
  });

  it("битый JSON/чужая форма → null без исключений", () => {
    expect(metricsFromStatsResult(null)).toBeNull();
    expect(metricsFromStatsResult("string")).toBeNull();
    expect(metricsFromStatsResult({ kind: "full" })).toBeNull();
    expect(metricsFromStatsResult({ kind: "full", payload: { distance: "x", duration: 1 } })).toBeNull();
  });

  it("teleportDistanceM отсутствует → 0 (записи до N-3)", () => {
    const m = metricsFromStatsResult({
      kind: "full",
      payload: { distance: 100, duration: 10 },
    });
    expect(m!.teleportDistanceM).toBe(0);
  });
});

// ——— §6 purge ———

describe("«Вариант 1» §6 buildTripCalcDeleteStatements — чанки ≤ 90", () => {
  it("мало id → один стейтмент", () => {
    const stmts = buildTripCalcDeleteStatements(["a", "b"]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe("DELETE FROM TripCalc WHERE sessionId IN (?, ?)");
    expect(stmts[0].args).toEqual(["a", "b"]);
  });

  it("200 id + 1 уникальный дубль-мусор → 3 чанка (90+90+21), дубли/пустые отфильтрованы", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const stmts = buildTripCalcDeleteStatements([...ids, "s0", "", "x"]);
    expect(stmts).toHaveLength(3);
    expect(stmts[0].args).toHaveLength(90);
    expect(stmts[2].args).toHaveLength(21);
  });

  it("пустой список → пусто", () => {
    expect(buildTripCalcDeleteStatements([])).toHaveLength(0);
  });
});

// ——— §7 статус для /health ———

describe("«Вариант 1» §7 tripCalcStatus — наблюдаемость слоя", () => {
  beforeEach(() => {
    resetTripCalcEnsureForTests();
  });

  it("до ensure: tableOk=null (неизвестно), слой не врёт", () => {
    const st = tripCalcStatus();
    expect(st.tableOk).toBeNull();
    expect(st.lastError).toBeNull();
  });
});

// ——— §8 сквозная регрессия N-8/N-6 на снапшотах ———

describe("«Вариант 1» §0 tripCalcScopeSql — скоупы sentinel-колонки", () => {
  it("own → параметризованный фильтр по владельцу", () => {
    expect(tripCalcScopeSql({ mode: "own", userId: "533778be" })).toEqual({
      clause: " AND userId = ?",
      args: ["533778be"],
    });
  });

  it("unclaimed → sentinel '' (НЕ «IS NULL»: колонка NOT NULL, инвариант StatsRollup)", () => {
    expect(tripCalcScopeSql({ mode: "unclaimed" })).toEqual({ clause: " AND userId = ''", args: [] });
  });

  it("all → без фильтра (админ: строки всех владельцев)", () => {
    expect(tripCalcScopeSql({ mode: "all" })).toEqual({ clause: "", args: [] });
  });
});

describe("«Вариант 1» §8 сквозная — бамп ОДНОГО конвейера не роняет чужие поля", () => {
  it("bump track 2→3: события продолжают обслуживаться из снапшота", () => {
    // после бампа конвейера трека снапшот-трек протух (пересчёт write-through),
    // события ШТАМП 1 не тронуты — сервис событий жив из снапшота
    const row = baseRow({ trackCacheV: 2 });
    expect(tripCalcServesTrack(row, FINAL_META, 400, 3, NOW)).toBe(false); // trackV протух
    expect(tripCalcServesEvents(row, FINAL_META, 1, NOW)).toBe(true); // eventsV жив
  });

  it("bump stats 2→3: рендер-трек/события продолжают обслуживаться", () => {
    const row = baseRow({ statsCacheV: 3 }); // метрики от нового конвейера
    expect(tripCalcServesTrack(row, FINAL_META, 400, 2, NOW)).toBe(true);
    expect(tripCalcServesEvents(row, FINAL_META, 1, NOW)).toBe(true);
  });
});
