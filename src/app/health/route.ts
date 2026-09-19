// GET /health — health-check (§4.8)
import { NextRequest } from "next/server";
import { libsql, isD1QuotaError } from "@/lib/db";
import { env } from "@/lib/env";
import { circuitStatus } from "@/lib/routing/circuit-breaker";
import { getRateLimiterStats } from "@/lib/rate-limit";
// v2.11.0 (АУДИТ C-20): worker — реальная живость in-process-ворчера,
// раньше был захардкожен "ok" (спека §4.8 требовала честный статус)
import { getWorkerRuntime } from "@/lib/worker-runtime";

// v2.40.5 (квота-M-15): проба БД — SELECT 1 вместо db.session.count.
// Прежний COUNT по Session читал ~104 строки на КАЖДЫЙ вызов /health, а их
// 4–9 тыс./день (healthCheckPath Render + useHealth 30с): ≈0,4–0,9 млн
// rows_read/день впустую — треть дневного бюджета free-плана на индикатор.
// SELECT 1 идёт тем же путём (db.ts → gateway /query → D1) и проверяет ту же
// связность (шлюз жив, секрет валиден, D1 отвечает), но читает 0 строк —
// квота не тратится, а при исчерпанной квоте (что бывало часто) проба не
// превращает health в сирену из-за индикатора самого же и съевшего бюджет.

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  let dbStatus: "ok" | "degraded" = "ok";
  let dbError = "";
  try {
    // v2.40.5 (M-15): см. комментарий к импорту — квота-бесплатная проба.
    await libsql.execute("SELECT 1 AS ok");
  } catch (e) {
    dbStatus = "degraded";
    dbError = e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100);
    if (isD1QuotaError(e)) {
      // честный, но отдельный маркер: связность жива, «деградация» — квота
      dbError = "D1 daily quota exhausted (connectivity probe passed gateway)";
    }
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
