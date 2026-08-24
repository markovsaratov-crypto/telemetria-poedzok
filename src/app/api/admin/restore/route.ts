// POST /api/admin/restore — восстановление из дампа (заглушка: список backups)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => ({}));
    const { backupId } = body as { backupId?: string };
    if (!backupId) return json({ error: "backupId required" }, 400, { "X-Request-Id": requestId });

    const job = await db.backupJob.findUnique({ where: { id: backupId } });
    if (!job) return json({ error: "Backup not found" }, 404, { "X-Request-Id": requestId });

    await writeAudit({
      action: "backup.restore",
      targetId: backupId,
      targetType: "BackupJob",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "admin-token",
      metadata: { sourceFile: job.filePath },
    });

    // В sandbox восстановление не выполняем автоматически (destructive). Возвращаем путь.
    return json({ status: "pending", backupId, filePath: job.filePath, message: "Restore queued. Run scripts/restore-backup.ts manually." }, 202, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Restore error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
