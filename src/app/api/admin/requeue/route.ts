// /api/admin/requeue — requeue dead TrafficJob (§4.9) / ExportJob (v2.38.1, ревью F9).
// Bearer ADMIN_TOKEN. v2.38.1 (F9): параметр type="traffic" (по умолчанию —
// обратная совместимость) | "export" — ручной «спас» застрявших экспорт-джобов
// (реклейм-механизм воркера теперь есть, но админ-ручка охватывает и их —
// семантика та же: pending, attempts=0, снятая блокировка).
import { NextRequest } from "next/server";
import { z } from "zod";
import { db, libsql } from "@/lib/db";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

// v2.16.0 (S2): тело валидируется zod (был голый as-cast — любой мусор в jobId/force)
const zRequeueBody = z.object({
  jobId: z.string().min(1),
  force: z.boolean().optional(),
  // v2.38.1 (F9): тип джоба — расширение админ-ручки на ExportJob
  type: z.enum(["traffic", "export"]).optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zRequeueBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const { jobId, force } = parsed.data;
    const jobType = parsed.data.type ?? "traffic"; // v2.38.1 (F9): default — прежнее поведение
    if (!jobId) return json({ error: "jobId required" }, 400, { "X-Request-Id": requestId });

    // ——— v2.38.1 (ревью F9): ветка ExportJob (таблица без updatedAt/lockedAt;
    // персист через сырой libsql, как в воркере; снятие блокировки _ExportJobLock) ———
    if (jobType === "export") {
      const job = await db.exportJob.findUnique({ where: { id: jobId } });
      if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
      // Семантика — как у TrafficJob ниже: без force — только dead/failed
      // (status='failed' у ExportJob не бывает — но проверка безвредна и
      // устойчива к будущим статусам)
      if (!force && job.status !== "dead" && job.status !== "failed") {
        return json({ error: "Job is not in dead/failed state" }, 400, { "X-Request-Id": requestId });
      }
      await libsql.execute({
        sql: `UPDATE ExportJob SET status = 'pending', attempts = 0, error = NULL, lockedBy = NULL, completedAt = NULL WHERE id = ?`,
        args: [jobId],
      });
      // Блокировка реклейма (worker-runtime F9) — снять, чтобы «свежий» pending
      // не реклеймнулся по старой метке
      await libsql.execute({
        sql: `DELETE FROM _ExportJobLock WHERE jobId = ?`,
        args: [jobId],
      }).catch(() => {}); // таблицы может ещё не быть — не критично
      await writeAudit({
        action: "export.requeue",
        targetId: jobId,
        targetType: "ExportJob",
        actorType: auth.via === "cookie" ? "user" : "system",
        actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"),
        sessionId: String(job.sessionId ?? ""),
        metadata: force ? { force: true, previousStatus: String(job.status ?? "") } : undefined,
      });
      return json({ ok: true, jobId, type: "export", status: "pending" }, 200, { "X-Request-Id": requestId });
    }

    const job = await db.trafficJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    // R5.1: force=true allows requeue of completed jobs (e.g. to re-run
    // routing with a newly configured 2ГИС key). Default (force=false)
    // preserves backward-compat: only dead/failed can be requeued.
    if (!force && job.status !== "dead" && job.status !== "failed") {
      return json({ error: "Job is not in dead/failed state" }, 400, { "X-Request-Id": requestId });
    }

    await db.trafficJob.update({
      where: { id: jobId },
      data: { status: "pending", attempts: 0, error: null, lockedBy: null, lockedAt: null, scheduledFor: new Date() },
    });
    await writeAudit({
      action: "traffic.requeue",
      targetId: jobId,
      targetType: "TrafficJob",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"), // v2.18.0: честная идентификация
      sessionId: String(job.sessionId ?? ""), // v2.18.0: типизированный db
      metadata: force ? { force: true, previousStatus: String(job.status ?? "") } : undefined,
    });
    return json({ ok: true, jobId, type: "traffic", status: "pending" }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Requeue error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
