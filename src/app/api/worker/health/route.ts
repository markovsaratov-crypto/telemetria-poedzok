// /api/worker/* — внутренние endpoints для Worker mini-service (§4.9). Bearer CRON_SECRET.
// GET  /api/worker/health   — self-check
// POST /api/worker/poll     — забрать pending TrafficJob (RETURNING id захват)
// POST /api/worker/complete — отдать результат обработки
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { inc } from "@/lib/metrics";

// GET /api/worker/health
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const pending = await db.trafficJob.count({ where: { status: "pending" } });
    const running = await db.trafficJob.count({ where: { status: "running" } });
    return json({ status: "ok", pendingJobs: pending, runningJobs: running, workerId: env().WORKER_ID }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker health error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
