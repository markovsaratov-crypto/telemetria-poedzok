// POST /api/worker/complete — Worker отдаёт результат обработки TrafficJob
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const { jobId, status, result, error } = (body || {}) as {
      jobId: string;
      status: "completed" | "failed" | "dead";
      result?: unknown;
      error?: string;
    };

    if (!jobId || !status) {
      return json({ error: "jobId and status required" }, 400, { "X-Request-Id": requestId });
    }

    const job = await db.trafficJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });

    const attempts = job.attempts + 1;
    const updateData: Record<string, unknown> = {
      status,
      attempts,
      updatedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    };
    if (status === "completed") {
      updateData.result = result ? JSON.stringify(result) : null;
      inc("traffic_job_completed_total", "Traffic jobs completed", 1);
    } else if (status === "failed") {
      updateData.error = error || "unknown";
      inc("traffic_job_failed_total", "Traffic jobs failed", 1);
      // Если attempts < 3 — requeue с backoff
      if (attempts < 3) {
        const backoffSec = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
        updateData.status = "pending";
        updateData.scheduledFor = new Date(Date.now() + backoffSec);
        updateData.error = null;
      } else {
        updateData.status = "dead";
      }
    } else if (status === "dead") {
      updateData.error = error || "max attempts exceeded";
    }

    await db.trafficJob.update({ where: { id: jobId }, data: updateData });
    return json({ ok: true, jobId, status: updateData.status, attempts }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker complete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
