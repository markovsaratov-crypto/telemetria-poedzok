// src/lib/backup.ts — логический дамп БД (BackupJob), верификация checksum (§9.8)
import { db } from "./db";
import { env } from "./env";
import { writeAudit } from "./audit";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";

export async function runBackup(actorId?: string): Promise<{ backupId: string; filePath: string; checksum: string; fileSize: number }> {
  // Создаём BackupJob
  const job = await db.backupJob.create({
    data: { status: "running", type: "full", lockedBy: env().WORKER_ID },
  });

  try {
    // Логический дамп: выгружаем все таблицы в JSON
    const dump = {
      version: env().APP_VERSION,
      timestamp: new Date().toISOString(),
      sessions: await db.session.findMany({ include: { gpsPoints: true } }),
      routes: await db.route.findMany(),
      routeCaches: await db.routeCache.findMany(),
      trafficJobs: await db.trafficJob.findMany(),
      auditLogs: await db.auditLog.findMany(),
      exportJobs: await db.exportJob.findMany(),
    };

    const content = JSON.stringify(dump, null, 2);
    const checksum = createHash("sha256").update(content).digest("hex");
    const fileSize = Buffer.byteLength(content);

    // Сохраняем в файл
    await fs.mkdir(env().BACKUP_STORAGE_DIR, { recursive: true });
    const fileName = `backup-${Date.now()}-${job.id}.json`;
    const filePath = path.join(env().BACKUP_STORAGE_DIR, fileName);
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
      metadata: { filePath, fileSize, checksum, verified },
    });

    return { backupId: job.id, filePath, checksum, fileSize };
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
