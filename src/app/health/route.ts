// GET /health — health-check (§4.8)
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
// v2.40.9 (Pack C, m-20): честный статус квоты — sticky-флаги d1-quota.ts
// (SELECT 1 не видит исчерпание: читает 0 строк и проходит; флаг ставится
// на РЕАЛЬНЫХ ошибках запросов в db-d1.ts и снимается успешными чтениями).
import { d1QuotaSnapshot } from "@/lib/d1-quota";
import { env } from "@/lib/env";
import { set } from "@/lib/metrics";
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
  }
  // v2.40.9 (Pack C, m-20): SELECT 1 ПРОХОДИТ при мёртвой read-квоте (0 строк) —
  // проба связности проверяет шлюз/секрет/латентность, но НЕ бюджет ДАННЫХ.
  // Sticky-флаг из d1-quota.ts (поставлен реальными ошибками запросов в
  // db-d1.ts) достраивает картину: db:degraded + честная причина, пока
  // сутки не кончились. Снятие — успешным чтением строк (db-d1.toResultSet)
  // или полуночью UTC; ноль дополнительной квоты на сам индикатор.
  const quota = d1QuotaSnapshot();
  set("d1_quota_read_exhausted", quota.readExhausted ? 1 : 0, "D1 daily READ quota exhausted (sticky flag, m-20)");
  set("d1_quota_write_exhausted", quota.writeExhausted ? 1 : 0, "D1 daily WRITE quota exhausted (sticky flag, m-20)");
  if (quota.readExhausted) {
    dbStatus = "degraded";
    const since = quota.readExhaustedAt ? quota.readExhaustedAt.slice(11, 16) : "??";
    dbError = `D1 daily READ quota exhausted since ${since} UTC (resets 00:00 UTC; connectivity probe passed — data reads will fail until reset, m-20)`;
  } else if (quota.writeExhausted && dbStatus === "ok") {
    dbStatus = "degraded";
    const since = quota.writeExhaustedAt ? quota.writeExhaustedAt.slice(11, 16) : "??";
    dbError = `D1 daily WRITE quota exhausted since ${since} UTC (reads alive; writes/finalize degraded until 00:00 UTC)`;
  }
  // v2.11.0 (C-20): worker запущен и не в shutdown → ok; не запущен → degraded
  const rt = getWorkerRuntime();
  const workerStatus: "ok" | "degraded" = rt && !rt.shuttingDown ? "ok" : "degraded";
  const body = JSON.stringify({
    status: dbStatus === "ok" && workerStatus === "ok" ? "ok" : "degraded",
    db: dbStatus,
    dbError: dbError || undefined,
    // v2.40.9 (Pack C, m-20): машиночитаемое состояние квоты (null = жива).
    d1Quota: {
      readExhaustedAt: quota.readExhaustedAt,
      writeExhaustedAt: quota.writeExhaustedAt,
    },
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
