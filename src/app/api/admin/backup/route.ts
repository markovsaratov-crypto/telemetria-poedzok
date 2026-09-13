// POST /api/admin/backup — запуск логического дампа (§9.8). Bearer ADMIN_TOKEN
// ИЛИ (v2.11.0, АУДИТ C-3) Bearer CRON_SECRET — только для backup-кронов Render.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdminOrCron, getUserIdFromRequest } from "@/lib/auth";
import { runBackup, listBackups } from "@/lib/backup";
import { backupToGitHub, isGitHubBackupConfigured, type DrillResult } from "@/lib/github-backup";
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
    // v2.32.0: ежедневный durable-уровень БЕЗ изменения инфраструктуры:
    // backup-крон (ежедневно 03:30) бьёт в этот роут — делаем не только
    // локальный дамп, но и загрузку ТОГО ЖЕ дампа в GitHub + read-back drill
    // (проверка восстановимости durable-копии). Прежний расклад: ежедневный
    // дамп — только эфемерный /tmp, durable-копия — лишь еженедельный
    // github-крон (окно потери до 7 дней). Сбой GitHub не роняет локальный
    // бэкап: результат локального дампа остаётся успешным (201), провал
    // аплоада — в поле github + журнал (поймает алерт backup_failure при
    // 3 подряд провалах и/или повторная попытка через github-крон ВС 04:00).
    let github: { ok: true; releaseUrl: string; tagName: string; drill: DrillResult } | { ok: false; error: string } | { ok: false; skipped: string } | null = null;
    if (isGitHubBackupConfigured()) {
      try {
        const gh = await backupToGitHub(actorId, {
          backupId: result.backupId,
          filePath: result.filePath,
          checksum: result.checksum,
          fileSize: result.fileSize,
          tableCounts: result.tableCounts,
        });
        github = { ok: true, releaseUrl: gh.releaseUrl, tagName: gh.releaseUrl.split("/").pop() ?? "", drill: gh.drill };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Backup: GitHub durable-копия не загружена (локальный дамп создан)", { requestId, backupId: result.backupId, error: msg });
        github = { ok: false, error: msg };
      }
    } else {
      github = { ok: false, skipped: "GITHUB_TOKEN not configured" };
    }
    return json({ backupId: result.backupId, status: "completed", checksum: result.checksum, fileSize: result.fileSize, tableCounts: result.tableCounts, github }, 201, { "X-Request-Id": requestId });
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
