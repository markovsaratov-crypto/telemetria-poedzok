// GET /api/stats/aggregate — totalDistance, totalDuration, avgSpeed from TrafficJob results.
// Iterates over completed TrafficJob.result (JSON) and aggregates plan metrics.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { trackLatency } from "@/lib/latency"; // P2-16

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // P2-13: учитываем только задачи ЖИВЫХ сессий — раньше mobile-KPI считал
    // soft-deleted сессии (36 vs 6 на экранах десктопа и мобильного)
    const aliveSessions = await db.session.findMany({ where: { deletedAt: null }, take: 10000 });
    const aliveIds = new Set(aliveSessions.map((s: Record<string, unknown>) => String(s.id)));

    // Find all completed TrafficJobs with a result
    const jobs = await db.trafficJob.findMany({
      where: { status: "completed" },
      take: 5000,
    });

    let totalDistanceM = 0;
    let totalDurationSec = 0;
    let jobCount = 0;
    let validCount = 0;

    for (const job of jobs) {
      if (!aliveIds.has(String(job.sessionId))) continue; // P2-13: soft-deleted вне KPI
      jobCount++;
      if (!job.result) continue;
      try {
        const parsed = JSON.parse(job.result) as {
          distanceM?: number;
          durationSec?: number;
          provider?: string;
        };
        if (typeof parsed.distanceM === "number") {
          totalDistanceM += parsed.distanceM;
          validCount++;
        }
        if (typeof parsed.durationSec === "number") {
          totalDurationSec += parsed.durationSec;
        }
      } catch {
        // skip unparseable results
      }
    }

    const avgSpeed =
      totalDurationSec > 0
        ? totalDistanceM / totalDurationSec // m/s
        : null;

    trackLatency(request); // P2-16: api_latency_p95

    return json(
      {
        sessionCount: validCount,
        totalDistanceM: Math.round(totalDistanceM),
        totalDistanceKm: Math.round((totalDistanceM / 1000) * 100) / 100,
        totalDurationSec: Math.round(totalDurationSec),
        totalDurationMin: Math.round(totalDurationSec / 60),
        avgSpeedMs: avgSpeed != null ? Math.round(avgSpeed * 100) / 100 : null,
        avgSpeedKmh: avgSpeed != null ? Math.round(avgSpeed * 3.6 * 100) / 100 : null,
        jobCount,
        validCount,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Aggregate stats error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
