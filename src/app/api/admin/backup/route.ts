// POST /api/admin/backup — запуск логического дампа (§9.8). Bearer ADMIN_TOKEN
// ИЛИ (v2.11.0, АУДИТ C-3) Bearer CRON_SECRET — только для backup-кронов Render.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdminOrCron, getUserIdFromRequest } from "@/lib/auth";
import { runBackup, listBackups } from "@/lib/backup";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeAdminOrCron(request);
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // v2.18.0: actorId — честная идентификация (userId при cookie-пользователе;
    // раньше любой cookie-админ записывался как легаси-"owner" — аудит не различал людей)
    const userId = await getUserIdFromRequest(request);
    const actorId = auth.role === "cron" ? "backup-cron" : userId ?? (auth.via === "cookie" ? "owner" : "admin-token");
    const result = await runBackup(actorId);
    return json({ backupId: result.backupId, status: "completed", checksum: result.checksum, fileSize: result.fileSize, tableCounts: result.tableCounts }, 201, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Backup error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Backup failed", message: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-Id": requestId });
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeAdminOrCron(request);
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const backups = await listBackups();
    return json({ backups }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Backup list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
