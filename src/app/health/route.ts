// GET /health — health-check (§4.8)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { circuitStatus } from "@/lib/routing/circuit-breaker";
import { getRateLimiterStats } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  let dbStatus: "ok" | "degraded" = "ok";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "degraded";
  }
  const body = JSON.stringify({
    status: dbStatus === "ok" ? "ok" : "degraded",
    db: dbStatus,
    worker: "ok",
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
