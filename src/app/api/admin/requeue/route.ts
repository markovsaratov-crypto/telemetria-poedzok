// /api/admin/requeue — requeue dead TrafficJob (§4.9). Bearer ADMIN_TOKEN.
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

// v2.16.0 (S2): тело валидируется zod (был голый as-cast — любой мусор в jobId/force)
const zRequeueBody = z.object({
  jobId: z.string().min(1),
  force: z.boolean().optional(),
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
    if (!jobId) return json({ error: "jobId required" }, 400, { "X-Request-Id": requestId });

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
      actorId: auth.via === "cookie" ? "owner" : "admin-token",
      sessionId: job.sessionId,
      metadata: force ? { force: true, previousStatus: job.status } : undefined,
    });
    return json({ ok: true, jobId, status: "pending" }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Requeue error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
