// tests/ingest-port.test.ts — v2.39.0 (§B1): юнит-тесты ПОРТАТИВНОГО модуля
// edge-инжеста cloudflare-worker/ingest-port.js. Проверяется ПАРИТЕТ с
// каноническим /api/ingest v2.38.2: валидация (зеркало zIngestBody),
// parseTimestamp (магнитуда-эвристика F74), нормализация+фильтры (F38/F39),
// gap-маркеры, TZ-день rollup (§A1.5), бюджет параметров D1 (90) и чанки
// DB.batch (≤400) при построении стейтментов, идемпотентность-скопы.
// Стейтменты НЕ исполняются — оцениваются СТРУКТУРА и ОГРАНИЧЕНИЯ (SQL-текст
// фиксирован модулем, значения — только связанные параметры).
import { describe, it, expect } from "vitest";
import {
  parseTimestamp,
  validateIngestBody,
  normalizeIngestPoints,
  countGapMarkers,
  rollupDayKey,
  buildIngestStatements,
  chunkStatements,
  findExistingSessionStatement,
  tombstoneSessionStatement,
  INGEST_MAX_POINTS,
  EDGE_PARAM_BUDGET,
  EDGE_BATCH_STMT_CHUNK,
  TS_PLAUSIBILITY_MS,
  MAX_TRUSTED_ACCURACY_M,
} from "../cloudflare-worker/ingest-port.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");

const validPoint = (timestamp: number, over: Record<string, unknown> = {}) => ({
  lat: 51.53,
  lon: 46.03,
  speed: 12.5,
  altitude: 150,
  accuracy: 10,
  bearing: 90,
  timestamp,
  ...over,
});

const validBody = (points: Array<Record<string, unknown>>) => ({
  deviceId: "sensor-logger-alpha",
  clientId: "batch-2026-09-18-0001",
  deviceName: "Тестовый логгер" as string | undefined,
  points,
});

describe("§B1 parseTimestamp — магнитуда-эвристика (порт parse-timestamp.ts, F74)", () => {
  it("секунды <1e10 → ×1000", () => {
    expect(parseTimestamp("1758148800")).toBe(1758148800 * 1000);
  });
  it("миллисекунды <1e13 → как есть", () => {
    expect(parseTimestamp("1758148800000")).toBe(1758148800000);
  });
  it("микросекунды <1e16 → /1e3 (ветка F74 — раньше давали 1970)", () => {
    expect(parseTimestamp("1758148800000000")).toBe(1758148800000);
  });
  it("наносекунды ≥1e16 → /1e6", () => {
    expect(parseTimestamp("1758148800000000000")).toBe(1758148800000);
  });
  it("ISO-строка → Date.parse", () => {
    expect(parseTimestamp("2026-09-18T10:00:00Z")).toBe(Date.parse("2026-09-18T10:00:00Z"));
  });
  it("мусор / пусто / ниже 1e9 → null", () => {
    expect(parseTimestamp("garbage")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("123")).toBeNull();
    expect(parseTimestamp("0")).toBeNull();
  });
});

describe("§B1 validateIngestBody — зеркало zIngestBody без Zod", () => {
  it("валидное тело → ok + нормализованный deviceName", () => {
    const r = validateIngestBody(validBody([validPoint(NOW)]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceId).toBe("sensor-logger-alpha");
      expect(r.value.clientId).toBe("batch-2026-09-18-0001");
      expect(r.value.deviceName).toBe("Тестовый логгер");
      expect(r.value.points).toHaveLength(1);
    }
  });

  it("deviceName отсутствует → null (не undefined — «Unsupported type» libsql)", () => {
    const b = validBody([validPoint(NOW)]);
    b.deviceName = undefined;
    const r = validateIngestBody(b);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.deviceName).toBeNull();
  });

  it("не-объект / массив / null → отказ", () => {
    expect(validateIngestBody(null).ok).toBe(false);
    expect(validateIngestBody([]).ok).toBe(false);
    expect(validateIngestBody("str").ok).toBe(false);
  });

  it("clientId с посторонними символами → отказ (инъекция в ключ идемпотентности)", () => {
    const b = validBody([validPoint(NOW)]);
    b.clientId = "batch; DROP TABLE Session";
    expect(validateIngestBody(b).ok).toBe(false);
  });

  it("points: пусто и сверх 1000 → отказ", () => {
    expect(validateIngestBody(validBody([])).ok).toBe(false);
    expect(validateIngestBody(validBody(new Array(INGEST_MAX_POINTS + 1).fill(validPoint(NOW)))).ok).toBe(false);
    expect(validateIngestBody(validBody(new Array(INGEST_MAX_POINTS).fill(validPoint(NOW)))).ok).toBe(true);
  });

  it("диапазоны полей: lat/lon/speed/bearing/accuracy/timestamp", () => {
    const cases: Array<[string, unknown]> = [
      ["lat", 91],
      ["lat", -91],
      ["lon", 181],
      ["lon", -181],
      ["speed", 90],
      ["speed", -1],
      ["bearing", 361],
      ["bearing", -1],
      ["accuracy", -1],
    ];
    for (const [field, bad] of cases) {
      const b = validBody([validPoint(NOW, { [field]: bad })]);
      expect(validateIngestBody(b).ok).toBe(false);
    }
    // timestamp строго number (JSON-канон приложения)
    expect(validateIngestBody(validBody([validPoint(NOW, { timestamp: "1758148800000" })])).ok).toBe(false);
    // конечность: NaN/Infinity не проходят
    expect(validateIngestBody(validBody([validPoint(NOW, { lat: Infinity })])).ok).toBe(false);
  });

  it("deviceId за пределами 1..64 → отказ", () => {
    const b = validBody([validPoint(NOW)]);
    b.deviceId = "";
    expect(validateIngestBody(b).ok).toBe(false);
    const b2 = validBody([validPoint(NOW)]);
    b2.deviceId = "d".repeat(65);
    expect(validateIngestBody(b2).ok).toBe(false);
  });
});

describe("§B1 normalizeIngestPoints — фильтры канонического роута (F38/F39)", () => {
  it("микс: валидные + битое время + accuracy 585 м → честные счётчики, сортировка", () => {
    // 1789729200 сек = 2026-09-18T11:00:00Z — NOW минус час, формат СЕКУНД
    const { normalized, droppedTimestamp, droppedInaccurate } = normalizeIngestPoints(
      [
        validPoint(NOW - 60_000), // мс, ок
        validPoint(1789729200), // СЕКУНДЫ (×1000 внутри порта) — внутри окна
        validPoint(1), // 1970 → окно ±24 ч → dropped (ts==null: ниже 1e9)
        validPoint(NOW + TS_PLAUSIBILITY_MS + 5000), // будущее за окном
        validPoint(NOW, { accuracy: 585 }), // мусор точности (AUDIT B-5)
        validPoint(NOW, { accuracy: 99.9 }), // на грани — ок
      ],
      NOW
    );
    expect(normalized).toHaveLength(3);
    expect(droppedTimestamp).toBe(2);
    expect(droppedInaccurate).toBe(1);
    // сортировка по возрастанию timestampMs
    expect(normalized.map((p) => p.timestampMs)).toEqual([...normalized.map((p) => p.timestampMs)].sort((a, b) => a - b));
    expect(normalized[0].timestampMs).toBeLessThan(normalized[2].timestampMs);
  });

  it("все точки отброшены → пустой normalized (роут ответит 400 dropped_all)", () => {
    const { normalized, droppedTimestamp } = normalizeIngestPoints(
      [validPoint(0), validPoint(1), validPoint(2)],
      NOW
    );
    expect(normalized).toHaveLength(0);
    expect(droppedTimestamp).toBe(3);
  });

  it("null-поля сохраняются как null (не «фальшивые нули»)", () => {
    const { normalized } = normalizeIngestPoints(
      [validPoint(NOW, { speed: null, altitude: null, accuracy: null, bearing: null })],
      NOW
    );
    expect(normalized[0].speed).toBeNull();
    expect(normalized[0].accuracy).toBeNull();
    expect(normalized[0].bearing).toBeNull();
  });
});

describe("§B1 countGapMarkers — разрывы > 30 с между СОСЕДНИМИ точками", () => {
  it("два разрыва по 31 с + короткий 29 с не в счёт", () => {
    const pts = [{ timestampMs: 0 }, { timestampMs: 31_000 }, { timestampMs: 62_500 }, { timestampMs: 91_500 }];
    expect(countGapMarkers(pts)).toBe(2);
  });
  it("монотонный поток без пауз → 0", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ timestampMs: i * 1000 }));
    expect(countGapMarkers(pts)).toBe(0);
  });
});

describe("§B1 rollupDayKey — день инжеста в TZ оператора (§A1.5)", () => {
  it("Europe/Saratov: 00:30 UTC — тот же день, 21:30 UTC — следующий", () => {
    expect(rollupDayKey(Date.parse("2026-09-18T00:30:00Z"), "Europe/Saratov")).toBe("2026-09-18");
    expect(rollupDayKey(Date.parse("2026-09-18T21:30:00Z"), "Europe/Saratov")).toBe("2026-09-19");
  });
  it("UTC по умолчанию", () => {
    expect(rollupDayKey(Date.parse("2026-09-18T23:59:59Z"))).toBe("2026-09-18");
  });
  it("невалидная зона — деградация на серверный пояс, не бросает", () => {
    expect(typeof rollupDayKey(Date.parse("2026-09-18T12:00:00Z"), "Not/AZone")).toBe("string");
  });
});

describe("§B1 buildIngestStatements — структура и лимиты D1", () => {
  // Свежий генератор id на КАЖДЫЙ тест (детерминизм без межтестового состояния):
  // сессия id-0, job id-1, точки id-2…
  const freshIds = () => {
    let n = 0;
    return () => `id-${n++}`;
  };
  const base = () => ({
    deviceId: "dev-1",
    clientId: "batch-1",
    deviceName: null as string | null,
    userId: null as string | null,
    now: NOW,
    newId: freshIds(),
  });

  it("25 точек → 1 Session + 3 GpsPoint + 1 TrafficJob + 1 StatsRollup = 6 стейтментов", () => {
    const pts = Array.from({ length: 25 }, (_, i) => validPoint(NOW - 25_000 + i * 1000));
    const { normalized } = normalizeIngestPoints(pts, NOW);
    const built = buildIngestStatements({ ...base(), normalized, payloadBytes: 1234, rollupDay: "2026-09-18" });
    expect(built.statements).toHaveLength(1 + 3 + 1 + 1);
    expect(built.sessionId).toBe("id-0");
    expect(built.jobId).toBe("id-1");
    expect(built.pointIds).toHaveLength(25);
  });

  it("МАКСИМУМ 1000 точек → 103 стейтмента, ОДНА группа batch (≤400), все GpsPoint ≤90 параметров", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => validPoint(NOW - 1_000_000 + i * 1000));
    const { normalized } = normalizeIngestPoints(pts, NOW);
    const built = buildIngestStatements({ ...base(), normalized, payloadBytes: 9999, rollupDay: "2026-09-18" });
    // 1 Session + 100 GpsPoint (1000/10) + 1 TrafficJob + 1 rollup
    expect(built.statements).toHaveLength(103);
    const groups = chunkStatements(built.statements);
    expect(groups).toHaveLength(1);
    for (const s of built.statements) {
      if (s.sql.startsWith("INSERT INTO GpsPoint")) {
        expect(s.args.length).toBeLessThanOrEqual(EDGE_PARAM_BUDGET);
        // 9 колонок × 10 строк = ровно бюджет
        expect(s.args.length % 9).toBe(0);
      }
    }
  });

  it("Session-стейтмент: значения связаны, статус completed в тексте, ISO-время", () => {
    const { normalized } = normalizeIngestPoints([validPoint(NOW), validPoint(NOW + 5000)], NOW);
    const built = buildIngestStatements({
      ...base(),
      deviceId: "dev-9",
      clientId: "batch-9",
      deviceName: "Логгер",
      userId: "usr-7",
      normalized,
      payloadBytes: 777,
      rollupDay: "2026-09-18",
    });
    const session = built.statements[0];
    expect(session.sql).toContain("'completed'");
    expect(session.args).toEqual([
      "id-0", // id
      "dev-9",
      "batch-9",
      "Логгер",
      new Date(NOW).toISOString(), // startTime
      new Date(NOW + 5000).toISOString(), // endTime
      2, // pointCount
      777, // payloadBytes
      "usr-7", // userId
      "id-1", // trafficJobId = jobId СРАЗУ (атомарный batch, комментарий модуля)
      new Date(NOW).toISOString(),
      new Date(NOW).toISOString(),
    ]);
  });

  it("StatsRollup-инкремент: UPSERT-дельта sessions+1/points+N на переданный день", () => {
    const { normalized } = normalizeIngestPoints([validPoint(NOW), validPoint(NOW + 1000)], NOW);
    const built = buildIngestStatements({ ...base(), normalized, payloadBytes: 1, rollupDay: "2026-09-17" });
    const rollup = built.statements.find((s) => s.sql.startsWith("INSERT INTO StatsRollup"));
    expect(rollup).toBeDefined();
    expect(rollup!.sql).toContain("ON CONFLICT(day, userId) DO UPDATE");
    expect(rollup!.sql).toContain("sessions = sessions + excluded.sessions");
    expect(rollup!.args[0]).toBe("2026-09-17"); // день СТАРТА сессии
    expect(rollup!.args[1]).toBe(""); // userId null → sentinel ''
    expect(rollup!.args[2]).toBe(2); // points+N
  });

  it("includeRollup=false → стейтмента rollup нет (воркер без таблицы)", () => {
    const { normalized } = normalizeIngestPoints([validPoint(NOW)], NOW);
    const built = buildIngestStatements({ ...base(), normalized, payloadBytes: 1, includeRollup: false });
    expect(built.statements.find((s) => s.sql.startsWith("INSERT INTO StatsRollup"))).toBeUndefined();
  });

  it("GpsPoint-строка: порядок колонок id, sessionId, lat, lon, …, timestamp, bearing", () => {
    const { normalized } = normalizeIngestPoints([validPoint(NOW, { speed: 5.5, bearing: 270 })], NOW);
    const built = buildIngestStatements({ ...base(), normalized, payloadBytes: 1, rollupDay: "2026-09-18" });
    const gp = built.statements[1];
    expect(gp.sql).toContain("(id, sessionId, lat, lon, speed, altitude, accuracy, timestamp, bearing)");
    expect(gp.args).toEqual(["id-2", "id-0", 51.53, 46.03, 5.5, 150, 10, NOW, 270]);
  });

  it("пользовательские данные НЕ попадают в SQL-текст (только параметры)", () => {
    const evil = `x'; DROP TABLE Session; --`;
    const { normalized } = normalizeIngestPoints([validPoint(NOW)], NOW);
    const built = buildIngestStatements({
      ...base(),
      deviceId: evil,
      clientId: "c1",
      deviceName: evil,
      normalized,
      payloadBytes: 1,
      rollupDay: "2026-09-18",
    });
    for (const s of built.statements) {
      expect(s.sql).not.toContain("DROP TABLE");
    }
    // значение ушло параметром
    expect(built.statements[0].args).toContain(evil);
  });
});

describe("§B1 chunkStatements — группы ≤400 (зеркало db.ts F5)", () => {
  it("405 стейтментов → 2 группы [400, 5]", () => {
    const stmts = Array.from({ length: 405 }, (_, i) => ({ sql: `-- ${i}`, args: [] }));
    const groups = chunkStatements(stmts);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(EDGE_BATCH_STMT_CHUNK);
    expect(groups[1]).toHaveLength(5);
  });
  it("пустой список → пусто", () => {
    expect(chunkStatements([])).toEqual([]);
  });
});

describe("§B1 идемпотентность — стейтменты-зеркала idempotency.ts", () => {
  it("канал владельца (userId null) → предикат userId IS NULL", () => {
    const s = findExistingSessionStatement({ deviceId: "d", clientId: "c", userId: null });
    expect(s.sql).toContain("userId IS NULL");
    expect(s.args).toEqual(["d", "c"]);
  });
  it("личный канал → userId = ? (изоляция v2.23.0)", () => {
    const s = findExistingSessionStatement({ deviceId: "d", clientId: "c", userId: "u1" });
    expect(s.sql).toContain("userId = ?");
    expect(s.args).toEqual(["d", "c", "u1"]);
  });
  it("надгробие soft-deleted: clientId = <c>#deleted#<первые 8 симв. id>", () => {
    const s = tombstoneSessionStatement("session-abcdefgh", "batch-1");
    // slice(0,8) «session-abcdefgh» = «session-» — зеркало idempotency.ts
    expect(s.args[0]).toBe("batch-1#deleted#session-");
    expect(s.args[1]).toBe("session-abcdefgh");
  });
});

describe("§B1 константы-зеркала (синхрон с src/)", () => {
  it("лимиты совпадают с каноническим роутом и db.ts", () => {
    expect(INGEST_MAX_POINTS).toBe(1000);
    expect(EDGE_PARAM_BUDGET).toBe(90); // db.ts D1_PARAM_BUDGET
    expect(EDGE_BATCH_STMT_CHUNK).toBe(400); // db.ts D1_BATCH_STMT_CHUNK
    expect(TS_PLAUSIBILITY_MS).toBe(24 * 60 * 60 * 1000); // ingest/route.ts
    expect(MAX_TRUSTED_ACCURACY_M).toBe(100); // kpi.ts MAX_TRUSTED_ACCURACY_M
  });
});
