// GET /api/metrics — Prometheus text exposition (§7.2)
// AUDIT B-13: эндпоинт больше не публичный — требует api-scope (cookie/API_KEY),
// иначе наружу утекают счётчики логинов/регистраций и трафика по путям.
import { NextRequest } from "next/server";
import { metricsText } from "@/lib/metrics";
import { set, TRAFFIC_JOB_DEAD_GAUGE } from "@/lib/metrics";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { getRateLimiterStats } from "@/lib/rate-limit";
import { circuitStatus } from "@/lib/routing/circuit-breaker";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const auth = await authorizeRequest(request, "api");
  if (!auth.ok) {
    return new Response("# unauthorized\n", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Request-Id": requestId },
    });
  }
  try {
    // Обновляем gauge-метрики (v2.16.0 (I5): 4 счётчика — параллельно)
    // v2.38.1 (ревью F15): gauge dead-джобов вместо фиктивного 'failed'
    // (такого статуса в TrafficJob нет) — и под другим ИМЕНЕМ
    // (traffic_job_dead_total): прежний traffic_job_failed_total в виде gauge
    // конфликтовал с одноимённым counter → двойной # TYPE в exposition →
    // Prometheus-парсер падал, весь scrape — 0 сэмплов. Имя — константа из
    // lib/metrics (единый источник, ревью F15).
    const [sessionCount, trafficJobPending, trafficJobRunning, trafficJobDead] = await Promise.all([
      db.session.count({ where: { deletedAt: null } }),
      db.trafficJob.count({ where: { status: "pending" } }),
      db.trafficJob.count({ where: { status: "running" } }),
      db.trafficJob.count({ where: { status: "dead" } }),
    ]);
    set("sessions_active_total", sessionCount, "Active sessions");
    set("traffic_job_pending_total", trafficJobPending, "Pending traffic jobs");
    set("traffic_job_running_total", trafficJobRunning, "Running traffic jobs");
    set(TRAFFIC_JOB_DEAD_GAUGE, trafficJobDead, "Traffic jobs dead (terminal, max attempts exceeded)");
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
    // v2.16.0 (B15): наружу — generic-текст (детали — в логи; err.message мог
    // светить внутренности БД)
    logger.error("metrics route failed", { requestId, error: err instanceof Error ? err.message : String(err) });
    return new Response("# error: internal server error\n", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
