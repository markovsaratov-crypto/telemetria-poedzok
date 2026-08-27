// /api/worker/* — внутренние endpoints для Worker (§4.9). Bearer CRON_SECRET.
// GET  /api/worker/health   — self-check (показывает и in-process worker state)
// POST /api/worker/poll     — забрать pending TrafficJob (RETURNING id захват)
// POST /api/worker/complete — отдать результат обработки
//
// Note: на Render/Vercel (single web-service) worker работает IN-PROCESS через
// instrumentation.ts → src/lib/worker-runtime.ts. mini-services/worker/ —
// отдельный Bun-процесс для локальной разработки (опционально).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { getWorkerRuntime } from "@/lib/worker-runtime";

// GET /api/worker/health
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const pending = await db.trafficJob.count({ where: { status: "pending" } });
    const running = await db.trafficJob.count({ where: { status: "running" } });
    const rt = getWorkerRuntime();
    return json({
      status: "ok",
      pendingJobs: pending,
      runningJobs: running,
      workerId: env().WORKER_ID,
      // In-process worker runtime info (если запущен через instrumentation.ts)
      inProcessWorker: rt
        ? {
            startedAt: new Date(rt.startedAt).toISOString(),
            uptimeSec: Math.floor((Date.now() - rt.startedAt) / 1000),
            inFlight: rt.inFlight.size,
            pollIntervalMs: rt.pollIntervalMs,
            shuttingDown: rt.shuttingDown,
          }
        : null,
    }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker health error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
