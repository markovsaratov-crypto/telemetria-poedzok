// GET /api/metrics — Prometheus text exposition (§7.2)
import { NextRequest } from "next/server";
import { metricsText } from "@/lib/metrics";
import { set } from "@/lib/metrics";
import { db } from "@/lib/db";
import { getRateLimiterStats } from "@/lib/rate-limit";
import { circuitStatus } from "@/lib/routing/circuit-breaker";

export async function GET(request: NextRequest) {
  try {
    // Обновляем gauge-метрики
    const sessionCount = await db.session.count({ where: { deletedAt: null } });
    const trafficJobPending = await db.trafficJob.count({ where: { status: "pending" } });
    const trafficJobRunning = await db.trafficJob.count({ where: { status: "running" } });
    const trafficJobFailed = await db.trafficJob.count({ where: { status: "failed" } });
    set("sessions_active_total", sessionCount, "Active sessions");
    set("traffic_job_pending_total", trafficJobPending, "Pending traffic jobs");
    set("traffic_job_running_total", trafficJobRunning, "Running traffic jobs");
    set("traffic_job_failed_total", trafficJobFailed, "Failed traffic jobs");
    set("rate_limiter_buckets", getRateLimiterStats().buckets, "Rate limiter buckets");

    const text = metricsText();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(`# error: ${err instanceof Error ? err.message : String(err)}\n`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
