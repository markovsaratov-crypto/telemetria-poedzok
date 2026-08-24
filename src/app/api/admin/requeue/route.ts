// /api/admin/requeue — requeue dead TrafficJob (§4.9). Bearer ADMIN_TOKEN.
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
    const { jobId } = body as { jobId?: string };
    if (!jobId) return json({ error: "jobId required" }, 400, { "X-Request-Id": requestId });

    const job = await db.trafficJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    if (job.status !== "dead" && job.status !== "failed") {
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
    });
    return json({ ok: true, jobId, status: "pending" }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Requeue error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
