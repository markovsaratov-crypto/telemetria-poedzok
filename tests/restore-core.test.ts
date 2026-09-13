import { describe, it, expect } from "vitest";
import { reviveBigInt, reviveRow, buildRestoreStatements, countDumpRows, type BackupDump } from "../src/lib/restore-core";

describe("restore-core: BigInt-оживление", () => {
  it("\"BIGINT:123\" → 123n", () => {
    expect(reviveBigInt("BIGINT:123")).toBe(BigInt(123));
  });
  it("обычная строка остаётся строкой", () => {
    expect(reviveBigInt("abc")).toBe("abc");
  });
  it("число остаётся числом", () => {
    expect(reviveBigInt(42)).toBe(42);
  });
  it("битые цифры → Number-фолбэк, не исключение", () => {
    expect(reviveBigInt("BIGINT:not-a-number")).toBe(NaN);
  });
  it("GpsPoint.timestamp оживает в BigInt, lat — нет", () => {
    const row = reviveRow("GpsPoint", { id: "p1", lat: 55.1, timestamp: "BIGINT:1723680010000" });
    expect(row.timestamp).toBe(BigInt(1723680010000));
    expect(row.lat).toBe(55.1);
  });
});

function miniDump(): BackupDump {
  return {
    version: "2.31.5",
    timestamp: "2026-09-13T00:00:00Z",
    Session: [{ id: "s1", userId: "u1", deviceId: "d1", startTime: "2026-09-01T10:00:00Z" }],
    GpsPoint: [{ id: "g1", sessionId: "s1", lat: 55, lon: 37, timestamp: "BIGINT:1723680010000" }],
    BackupJob: [
      { id: "b-current", status: "completed", filePath: "/tmp/x.json" },
      { id: "b-old", status: "completed", filePath: "/tmp/y.json" },
    ],
    Setting: [],
  };
}

describe("restore-core: buildRestoreStatements", () => {
  it("текущая BackupJob-строка сохраняется (DELETE WHERE id != current), из дампа не вставляется повторно", () => {
    const { stmts } = buildRestoreStatements(miniDump(), "b-current");
    const delBackup = stmts.find(s => s.sql.startsWith("DELETE FROM BackupJob"));
    expect(delBackup?.sql).toContain("WHERE id != ?");
    expect(delBackup?.args).toEqual(["b-current"]);
    // b-old вставляется, b-current — нет
    const inserts = stmts.filter(s => s.sql.startsWith("INSERT INTO BackupJob"));
    expect(inserts).toHaveLength(1);
    expect(JSON.stringify(inserts[0].args)).toContain("b-old");
  });

  it("FK-порядок: удаление GpsPoint раньше Session, вставка Session раньше GpsPoint", () => {
    const { stmts } = buildRestoreStatements(miniDump(), "b-current");
    const idx = (prefix: string, table: string) =>
      stmts.findIndex(s => s.sql === `DELETE FROM ${table}`.replace(prefix, prefix)) >= 0
        ? stmts.findIndex(s => s.sql.startsWith(prefix + table))
        : -1;
    //DELETE порядок: children first
    const delGps = stmts.findIndex(s => s.sql === "DELETE FROM GpsPoint");
    const delSession = stmts.findIndex(s => s.sql === "DELETE FROM Session");
    expect(delGps).toBeGreaterThanOrEqual(0);
    expect(delSession).toBeGreaterThan(delGps);
    //INSERT порядок: parents first
    const insSession = stmts.findIndex(s => s.sql.startsWith("INSERT INTO Session"));
    const insGps = stmts.findIndex(s => s.sql.startsWith("INSERT INTO GpsPoint"));
    expect(insSession).toBeGreaterThanOrEqual(0);
    expect(insGps).toBeGreaterThan(insSession);
  });

  it("неизвестные колонки отбрасываются (инъекция/мусор дампа)", () => {
    const dump: BackupDump = {
      version: "x", timestamp: "x",
      Session: [{ id: "s1", evil: "DROP TABLE Session;--", userId: "u1" } as Record<string, unknown>],
    };
    const { stmts } = buildRestoreStatements(dump, "b");
    const ins = stmts.find(s => s.sql.startsWith("INSERT INTO Session"));
    expect(ins).toBeDefined();
    expect(ins!.sql).not.toContain("evil");
    expect(JSON.stringify(ins!.args)).not.toContain("DROP TABLE");
  });

  it("пустые таблицы дают tablesCount=0 и не генерируют INSERT", () => {
    const { stmts, tablesCount } = buildRestoreStatements(miniDump(), "b-current");
    expect(tablesCount.Setting).toBe(0);
    expect(stmts.some(s => s.sql.startsWith("INSERT INTO Setting"))).toBe(false);
  });

  it("unknownTables подсвечивает неожиданные ключи дампа", () => {
    const dump = miniDump() as BackupDump & { WeirdTable: unknown[] };
    dump.WeirdTable = [{ id: 1 }];
    const { unknownTables } = buildRestoreStatements(dump, "b-current");
    expect(unknownTables).toEqual(["WeirdTable"]);
  });
});

describe("restore-core: countDumpRows (read-back drill)", () => {
  it("считает строки известных таблиц, User — нет", () => {
    const dump = miniDump() as BackupDump & { users: unknown[] };
    dump.users = [{ id: "u1" }, { id: "u2" }];
    const counts = countDumpRows(dump);
    expect(counts.Session).toBe(1);
    expect(counts.GpsPoint).toBe(1);
    expect(counts.Setting).toBe(0);
    expect(counts.users).toBeUndefined();
  });
});
