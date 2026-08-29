// POST /api/admin/restore — restore DB from a logical JSON dump (§9.8 / R5.3).
// Bearer ADMIN_TOKEN or owner/admin cookie.
//
// Flow:
//   1) Auth (admin)
//   2) Find BackupJob by id (must be status=completed with filePath+checksum)
//   3) Read file, recompute SHA256, compare to stored checksum (if recorded)
//   4) Parse JSON dump ({version,timestamp,Session[],GpsPoint[],...})
//   5) libsql transaction: TRUNCATE every table (FK-safe order) + INSERT all
//      rows from dump (forward FK order)
//   6) Audit log entry for restore action (written AFTER restore so it
//      survives the truncate)
//   7) Return { ok, restoredAt, backupId, tablesCount, checksumVerified }
//
// Notes:
//   - BigInt columns (GpsPoint.timestamp) are stored in dump as
//     "BIGINT:<digits>" strings — converted back to BigInt on insert.
//   - The current BackupJob row (id=backupId) is preserved across truncate
//     to avoid losing the restore provenance.
//   - In sandbox libsql with file: URL, no Prisma $disconnect is required —
//     each libsql.execute is atomic and uses the same on-disk SQLite file.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";

export const dynamic = "force-dynamic";

// Backup dump includes these top-level array keys (see src/lib/backup.ts).
const TABLES = [
  "Session",
  "GpsPoint",
  "Route",
  "RouteCache",
  "TrafficJob",
  "AuditLog",
  "ExportJob",
  "BackupJob",
  "Setting",
] as const;

// Tables that need BigInt revival for the timestamp column.
const BIGINT_COLUMNS: Record<string, string[]> = {
  GpsPoint: ["timestamp"],
};

// FK-safe delete order: children first, then parents.
const DELETE_ORDER: ReadonlyArray<(typeof TABLES)[number]> = [
  "GpsPoint",
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
  "RouteCache",
  "TrafficJob",
  "ExportJob",
  "AuditLog",
  "GpsPoint",
];

interface BackupDump {
  version: string;
  timestamp: string;
  users?: Array<Record<string, unknown>>;
  [table: string]: unknown;
}

function reviveBigInt(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("BIGINT:")) {
    const digits = value.slice("BIGINT:".length);
    try {
      // Use global BigInt constructor (works even on lower ES targets).
      return (globalThis as { BigInt?: (s: string) => unknown }).BigInt
        ? (globalThis as { BigInt: (s: string) => unknown }).BigInt(digits)
        : Number(digits);
    } catch {
      return Number(digits);
    }
  }
  return value;
}

function reviveRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const bigintCols = BIGINT_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = bigintCols.includes(k) ? reviveBigInt(v) : v;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => ({}));
    const { backupId } = body as { backupId?: string };
    if (!backupId) return json({ error: "backupId required" }, 400, { "X-Request-Id": requestId });

    // 2) Find BackupJob
    const job = await db.backupJob.findUnique({ where: { id: backupId } });
    if (!job) return json({ error: "Backup not found" }, 404, { "X-Request-Id": requestId });
    const filePath = job.filePath;
    if (!filePath) {
      return json({ error: "Backup has no filePath (not yet completed)" }, 400, { "X-Request-Id": requestId });
    }
    if (job.status !== "completed") {
      return json({ error: `Backup status is '${job.status}', must be 'completed'` }, 400, { "X-Request-Id": requestId });
    }

    // 3) Read file (BACKUP_STORAGE_DIR is /tmp/backups per src/lib/backup.ts).
    // Resolve relative paths against the canonical BACKUP_STORAGE_DIR.
    const BACKUP_STORAGE_DIR = "/tmp/backups";
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(BACKUP_STORAGE_DIR, filePath);
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, "utf8");
    } catch (err) {
      logger.error("Restore: read file failed", { requestId, backupId, path: resolvedPath, error: err instanceof Error ? err.message : String(err) });
      return json({ error: "Backup file not readable", path: resolvedPath }, 500, { "X-Request-Id": requestId });
    }

    // 4) Validate SHA256 checksum if recorded
    let checksumVerified: boolean | null = null;
    if (job.checksum) {
      const actual = createHash("sha256").update(content).digest("hex");
      checksumVerified = actual === job.checksum;
      if (!checksumVerified) {
        await writeAudit({
          action: "backup.restore",
          targetId: backupId,
          targetType: "BackupJob",
          actorType: auth.via === "cookie" ? "user" : "system",
          actorId: auth.via === "cookie" ? "owner" : "admin-token",
          metadata: { checksumVerified: false, expected: job.checksum, actual },
        });
        return json({ error: "Checksum mismatch — backup file is corrupt", backupId, expected: job.checksum, actual }, 422, { "X-Request-Id": requestId });
      }
    }

    // 5) Parse dump JSON
    let dump: BackupDump;
    try {
      dump = JSON.parse(content) as BackupDump;
    } catch (err) {
      return json({ error: "Backup file is not valid JSON", detail: err instanceof Error ? err.message : String(err) }, 422, { "X-Request-Id": requestId });
    }

    // 6) Truncate + insert in a transaction. libsql client supports batch()
    // for atomic multi-statement execution. We use individual execute() calls
    // wrapped in BEGIN/COMMIT to keep semantics simple + portable.
    const restoredAt = new Date().toISOString();
    const tablesCount: Record<string, number> = {};

    // BEGIN transaction
    await libsql.execute("BEGIN");
    try {
      // Delete children first, parents last (FK-safe).
      for (const table of DELETE_ORDER) {
        // Preserve the current BackupJob row so the restore provenance is not lost.
        if (table === "BackupJob") {
          await libsql.execute({ sql: `DELETE FROM BackupJob WHERE id != ?`, args: [backupId] });
        } else {
          await libsql.execute(`DELETE FROM ${table}`);
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
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const placeholders = keys.map(() => "?").join(", ");
          const values = keys.map((k) => row[k]);
          await libsql.execute({
            sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
            args: values as never,
          });
        }
        tablesCount[table] = rows.length;
      }

      await libsql.execute("COMMIT");
    } catch (err) {
      try { await libsql.execute("ROLLBACK"); } catch {}
      logger.error("Restore: transaction failed, rolled back", { requestId, backupId, error: err instanceof Error ? err.message : String(err) });
      // Pre-restore audit (might be inside rolled-back tx → write again on the live DB)
      await writeAudit({
        action: "backup.restore",
        targetId: backupId,
        targetType: "BackupJob",
        actorType: auth.via === "cookie" ? "user" : "system",
        actorId: auth.via === "cookie" ? "owner" : "admin-token",
        metadata: { error: err instanceof Error ? err.message : String(err), checksumVerified },
      });
      return json({ error: "Restore transaction failed — rolled back, DB unchanged", detail: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-Id": requestId });
    }

    // 7) Audit log entry for successful restore (written AFTER commit, so it
    // survives in the restored DB and is associated with the restore action).
    await writeAudit({
      action: "backup.restore",
      targetId: backupId,
      targetType: "BackupJob",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "admin-token",
      metadata: { restoredAt, sourceFile: filePath, checksumVerified, tablesCount, dumpVersion: dump.version, dumpTimestamp: dump.timestamp },
    });

    const totalRows = Object.values(tablesCount).reduce((a, b) => a + b, 0);
    return json(
      { ok: true, restoredAt, backupId, filePath, checksumVerified, tablesCount, totalRows, dumpVersion: dump.version, dumpTimestamp: dump.timestamp },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Restore error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
