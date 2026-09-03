// GET /api/admin/jobs — список TrafficJob для admin panel (§4.9 admin view).
// Query: ?status=pending|running|failed|dead|completed&limit=50
//
// v2.18.0: РОУТ ПЕРЕПИСАН. Раньше передавался `select: { …, session: { select } }`,
// который db.trafficJob.findMany НЕ поддерживал (только include) — поле session
// молча не прицеплялось, карточка джобов вечно показывала «—» вместо устройства.
// Плюс SELECT * переливал result-блоб маршрутизации на каждый 15-с poll.
// Теперь: include.session + явная проекция строк (id/status/attempts/… + deviceId).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    // v2.18.0: NaN/отрицательный limit больше не просачивается в LIMIT
    // (LIMIT -1 в SQLite = «без лимита»; NaN ронял bind). Clamp 1..200.
    const limitRaw = Number.parseInt(url.searchParams.get("limit") || "50", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const jobs = await db.trafficJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { session: {} },
    });

    // Summary counts
    const counts = await db.trafficJob.groupBy({
      by: ["status"],
      _count: true,
    });
    const summary: Record<string, number> = {};
    for (const c of counts) summary[String(c.status)] = Number(c._count);

    // Проекция: без result-блоба (может быть сотни КБ JSON на джоб), session —
    // только deviceId/startTime (всё, что читает карточка).
    const projected = jobs.map((j) => {
      const job = j as Record<string, unknown>;
      const session = (job.session ?? null) as Record<string, unknown> | null;
      return {
        id: String(job.id),
        sessionId: String(job.sessionId ?? ""),
        status: String(job.status ?? ""),
        attempts: Number(job.attempts ?? 0),
        lockedBy: job.lockedBy == null ? null : String(job.lockedBy),
        lockedAt: job.lockedAt == null ? null : String(job.lockedAt),
        error: job.error == null ? null : String(job.error),
        createdAt: String(job.createdAt ?? ""),
        updatedAt: String(job.updatedAt ?? ""),
        scheduledFor: job.scheduledFor == null ? null : String(job.scheduledFor),
        session: session
          ? { deviceId: String(session.deviceId ?? "—"), startTime: session.startTime == null ? null : String(session.startTime) }
          : null,
      };
    });

    return json({ jobs: projected, summary, total: projected.length }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Admin jobs error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
