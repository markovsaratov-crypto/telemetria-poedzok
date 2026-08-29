// src/lib/backup.ts — логический дамп БД (BackupJob), верификация checksum (§9.8)
import { db, libsql } from "./db";
import { env } from "./env";
import { writeAudit } from "./audit";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";

// P0-фикс v2.9.10 (Render build failure): Turbopack static analysis помечает
// fs-операции с динамическим путём из env() как "dynamic filesystem access" →
// трассировка всего проекта → build failed на Render. Решение: использовать
// ЧИСТЫЙ СТРОКОВЫЙ ЛИТЕРАЛ "/tmp/backups" (то же значение что и env var
// BACKUP_STORAGE_DIR в render.yaml). Turbopack видит константу — никакой
// динамической трассировки. Env-переопределение BACKUP_STORAGE_DIR намеренно
// не используется (поведение на проде идентично env var значению).
const BACKUP_STORAGE_DIR = "/tmp/backups";

export async function runBackup(actorId?: string): Promise<{ backupId: string; filePath: string; checksum: string; fileSize: number; tableCounts: Record<string, number> }> {
  // Создаём BackupJob
  const job = await db.backupJob.create({
    data: { status: "running", type: "full", lockedBy: env().WORKER_ID },
  });

  try {
    // Логический дамп: полные выгрузки ВСЕХ строк всех таблиц напрямую через libsql.
    // P0-фикс (v2.9.1): db-обёртки findMany имеют тихие лимиты (take=20/50) и
    // db.session.findMany игнорирует include → бэкап терял GPS-точки и хвосты таблиц.
    // Спека §8.2/§9.8 требует полного экспорта — прямой SQL гарантирует полноту.
    const tables = [
      "Session", "GpsPoint", "Route", "RouteCache", "TrafficJob",
      "AuditLog", "ExportJob", "BackupJob", "Setting",
    ] as const;
    const rows: Record<string, unknown[]> = {};
    const tableCounts: Record<string, number> = {};
    for (const table of tables) {
      const res = await libsql.execute(`SELECT * FROM ${table}`);
      rows[table] = res.rows as unknown[];
      tableCounts[table] = res.rows.length;
    }
    const dump = {
      version: env().APP_VERSION,
      timestamp: new Date().toISOString(),
      ...rows,
      // User: без секретов (passwordHash) — только идентификационные поля
      users: (await libsql.execute("SELECT id, email, role, createdAt, updatedAt FROM User")).rows,
    };
    tableCounts.User = dump.users.length;

    // BigInt-safe serialization: GpsPoint.timestamp is BigInt, JSON.stringify падает
    // Заменяем BigInt на строковое представление
    const content = JSON.stringify(dump, (key, value) =>
      typeof value === "bigint" ? `BIGINT:${value.toString()}` : value
    , 2);
    const checksum = createHash("sha256").update(content).digest("hex");
    const fileSize = Buffer.byteLength(content);

    // Сохраняем в файл (статический путь — Turbopack-friendly, см. коммент в начале файла)
    await fs.mkdir(BACKUP_STORAGE_DIR, { recursive: true });
    const fileName = `backup-${Date.now()}-${job.id}.json`;
    const filePath = path.join(BACKUP_STORAGE_DIR, fileName);
    await fs.writeFile(filePath, content, "utf8");

    // Верификация: перечитываем и сравниваем checksum
    let verified = false;
    if (env().BACKUP_VERIFICATION_ENABLED === "true") {
      const reread = await fs.readFile(filePath, "utf8");
      const recheck = createHash("sha256").update(reread).digest("hex");
      verified = recheck === checksum;
      if (!verified) {
        throw new Error("Backup verification failed: checksum mismatch");
      }
    }

    await db.backupJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        filePath,
        fileSize,
        checksum,
        completedAt: new Date(),
      },
    });

    await writeAudit({
      action: "backup.create",
      targetId: job.id,
      targetType: "BackupJob",
      actorType: actorId ? "user" : "backup-cron",
      actorId,
      metadata: { filePath, fileSize, checksum, verified, tableCounts },
    });

    return { backupId: job.id, filePath, checksum, fileSize, tableCounts };
  } catch (err) {
    await db.backupJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    });
    throw err;
  }
}

export async function listBackups() {
  return db.backupJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}
