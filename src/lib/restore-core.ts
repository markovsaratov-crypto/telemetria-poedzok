// src/lib/restore-core.ts — чистое ядро restore (без HTTP/авторизации).
// Извлечено из /api/admin/restore/route.ts (v2.32.0): один источник таблиц/порядков/
// BigInt-оживления для локального restore и restore-from-GitHub + покрывается
// unit-тестами (tests/restore-core.test.ts). Логика дословно прежняя.
export interface BackupDump {
  version: string;
  timestamp: string;
  users?: Array<Record<string, unknown>>;
  [table: string]: unknown;
}

// Backup dump includes these top-level array keys (see src/lib/backup.ts).
const TABLES = [
  "Session",
  "GpsPoint",
  "Trip",
  "IngestMessage",
  "Route",
  "RouteCache",
  "TrafficJob",
  "AuditLog",
  "ExportJob",
  "BackupJob",
  "Setting",
  "_AlertState",
] as const;

// Tables that need BigInt revival for the timestamp column.
const BIGINT_COLUMNS: Record<string, string[]> = {
  GpsPoint: ["timestamp"],
};

// Колонки-вайлист для рестора: неизвестные колонки из дампа отбрасываются
// (с журналом у вызывающего), полностью пустые строки — пропускаются.
const ALLOWED_COLUMNS: Record<string, ReadonlyArray<string>> = {
  Session: ["id", "userId", "deviceId", "clientId", "deviceName", "startTime", "endTime", "pointCount", "payloadBytes", "status", "deletedAt", "purgedAt", "routeId", "routeHash", "topologyHash", "trafficJobId", "notes", "tags", "createdAt", "updatedAt", "statsCache", "eventsCache", "trackCache", "cachePointCount", "cacheVersion"],
  GpsPoint: ["id", "sessionId", "lat", "lon", "speed", "altitude", "accuracy", "timestamp", "bearing"],
  // Trip — колонки prisma/schema.prisma (без join-таблицы: состав поездки
  // хранится в sessionIds JSON, _SessionTrips в БД нет).
  Trip: ["id", "deviceId", "userId", "status", "startTime", "endTime", "spanStart", "spanEnd", "startLat", "startLon", "endLat", "endLon", "sessionIds", "sessionCount", "deletedAt", "trafficJobId", "createdAt", "updatedAt", "activeDurationSec", "movingTimeSec", "idleTimeSec", "gapTimeSec", "interFragmentGapSec", "internalStopTimeSec", "distanceM", "pointCountActual", "maxSpeedMs", "ecoScore", "planDistanceM", "planDurationSec", "planComparable", "planCoverage", "routingLegCount", "statsComputedAt"],
  IngestMessage: ["deviceId", "messageId", "firstSeenAt"],
  _AlertState: ["key", "value", "updatedAt"],
  Route: ["id", "userId", "name", "description", "startLat", "startLon", "endLat", "endLon", "createdAt", "updatedAt"],
  RouteCache: ["id", "hash", "result", "todBucket", "routeId", "expiresAt", "createdAt"],
  TrafficJob: ["id", "sessionId", "status", "attempts", "priority", "scheduledFor", "lockedBy", "lockedAt", "result", "error", "createdAt", "updatedAt"],
  AuditLog: ["id", "userId", "action", "targetId", "targetType", "actorType", "actorId", "metadata", "sessionId", "createdAt"],
  ExportJob: ["id", "sessionId", "format", "status", "fileUrl", "fileSize", "expiresAt", "attempts", "lockedBy", "createdAt", "completedAt", "error"],
  BackupJob: ["id", "status", "type", "filePath", "fileSize", "checksum", "attempts", "lockedBy", "createdAt", "completedAt", "error"],
  Setting: ["key", "value", "updatedAt", "updatedBy"],
};

// FK-safe delete order: children first, then parents.
const DELETE_ORDER: ReadonlyArray<(typeof TABLES)[number]> = [
  "GpsPoint",
  "Trip",
  "IngestMessage",
  "_AlertState",
  "AuditLog",
  "ExportJob",
  "TrafficJob",
  "RouteCache",
  "Session",
  "Route",
  "BackupJob",
  "Setting",
];

// FK-safe insert order: parents first, then children.
const INSERT_ORDER: ReadonlyArray<(typeof TABLES)[number]> = [
  "Setting",
  "BackupJob",
  "Route",
  "Session",
  "Trip",
  "RouteCache",
  "TrafficJob",
  "ExportJob",
  "AuditLog",
  "GpsPoint",
  "IngestMessage",
  "_AlertState",
];

export function reviveBigInt(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("BIGINT:")) {
    const digits = value.slice("BIGINT:".length);
    try {
      return (globalThis as { BigInt?: (s: string) => unknown }).BigInt
        ? (globalThis as { BigInt: (s: string) => unknown }).BigInt(digits)
        : Number(digits);
    } catch {
      return Number(digits);
    }
  }
  return value;
}

export function reviveRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const bigintCols = BIGINT_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = bigintCols.includes(k) ? reviveBigInt(v) : v;
  }
  return out;
}

export interface RestoreStatement {
  sql: string;
  args: unknown[];
}

export interface RestoreBuildResult {
  stmts: RestoreStatement[];
  tablesCount: Record<string, number>;
  /** Ключи дампа, не входящие в известный набор таблиц (кроме служебных) — для warn-лога. */
  unknownTables: string[];
}

/**
 * Собирает statements атомарного restore-батча: DELETE всех таблиц в FK-safe
 * порядке (текущая BackupJob-строка `backupId` сохраняется для провенанса) +
 * INSERT строк дампа (parents first). Логика дословно из restore-роута.
 */
export function buildRestoreStatements(dump: BackupDump, backupId: string): RestoreBuildResult {
  const stmts: RestoreStatement[] = [];
  const tablesCount: Record<string, number> = {};

  // v2.32.0 (найдено функциональным тестом): _AlertState создаётся рантаймом
  // alerts.ts (CREATE TABLE IF NOT EXISTS), а не prisma-схемой — свежая БД из
  // `prisma db push` её НЕ имеет, и restore в такую БД падал «no such table».
  // Самовосстановление схемы: no-op на существующей таблице, спасает restore
  // в новую БД (runbook полного переноса).
  stmts.push({
    sql: "CREATE TABLE IF NOT EXISTS _AlertState (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
    args: [],
  });

  // Delete children first, parents last (FK-safe).
  for (const table of DELETE_ORDER) {
    // Preserve the current BackupJob row so the restore provenance is not lost.
    if (table === "BackupJob") {
      stmts.push({ sql: `DELETE FROM BackupJob WHERE id != ?`, args: [backupId] });
    } else {
      stmts.push({ sql: `DELETE FROM ${table}`, args: [] });
    }
  }

  // Insert parents first, children last (FK-safe).
  for (const table of INSERT_ORDER) {
    const rows = (dump[table] as Array<Record<string, unknown>> | undefined) ?? [];
    if (rows.length === 0) {
      tablesCount[table] = 0;
      continue;
    }
    for (const rawRow of rows) {
      // Don't re-insert the current BackupJob row (already preserved).
      if (table === "BackupJob" && rawRow.id === backupId) continue;
      const row = reviveRow(table, rawRow);
      const allowed = ALLOWED_COLUMNS[table] ?? [];
      const keys = Object.keys(row).filter((k) => allowed.includes(k));
      if (keys.length === 0) continue;
      const placeholders = keys.map(() => "?").join(", ");
      const values = keys.map((k) => row[k]);
      stmts.push({
        sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
        args: values,
      });
    }
    tablesCount[table] = rows.length;
  }

  const known = new Set<string>([...TABLES, "version", "timestamp", "users"]);
  const unknownTables = Object.keys(dump).filter((k) => !known.has(k));
  return { stmts, tablesCount, unknownTables };
}

/** Счётчики строк дампа по таблицам (для drill-проверки и сверок без SQL). */
export function countDumpRows(dump: BackupDump): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = (dump[table] as Array<Record<string, unknown>> | undefined) ?? [];
    counts[table] = rows.length;
  }
  return counts;
}
