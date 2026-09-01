// GET /health — health-check (§4.8)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { circuitStatus } from "@/lib/routing/circuit-breaker";
import { getRateLimiterStats } from "@/lib/rate-limit";
// v2.11.0 (АУДИТ C-20): worker — реальная живость in-process-ворчера,
// раньше был захардкожен "ok" (спека §4.8 требовала честный статус)
import { getWorkerRuntime } from "@/lib/worker-runtime";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  let dbStatus: "ok" | "degraded" = "ok";
  let dbError = "";
  try {
    // Use model count instead of $queryRaw (libsql adapter compatibility)
    await db.session.count({ where: { deletedAt: null }, take: 1 });
  } catch (e) {
    dbStatus = "degraded";
    dbError = e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100);
  }
  // v2.11.0 (C-20): worker запущен и не в shutdown → ok; не запущен → degraded
  const rt = getWorkerRuntime();
  const workerStatus: "ok" | "degraded" = rt && !rt.shuttingDown ? "ok" : "degraded";
  const body = JSON.stringify({
    status: dbStatus === "ok" && workerStatus === "ok" ? "ok" : "degraded",
    db: dbStatus,
    dbError: dbError || undefined,
    worker: workerStatus,
    workerUptimeSec: rt ? Math.round((Date.now() - rt.startedAt) / 1000) : 0,
    circuits: circuitStatus(),
    rateLimiter: getRateLimiterStats(),
    version: env().APP_VERSION,
    uptime: process.uptime(),
    targetLoadRpm: env().TARGET_LOAD_RPM,
    rateLimitMaxIngest: env().RATE_LIMIT_MAX_INGEST,
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": requestId,
    },
  });
}
