// src/lib/worker-runtime.ts — In-process Worker (запускается через instrumentation.ts).
//
// В отличие от mini-services/worker/ (отдельный Bun-процесс на :3001), этот
// модуль работает ВНУТРИ Next.js процесса. Это нужно потому что:
//   - Render Free tier: можно запустить только 1 web-сервис.
//   - Vercel: serverless функции не держат long-running poll-loop.
//   - Отдельный Worker-сервис на Render = платный план.
//
// Решение "без костылей": instrumentation.ts (официальный Next.js 16 механизм)
// запускает этот модуль один раз при старте сервера. Worker использует
// ПРЯМОЙ доступ к БД через libsql (db-клиент из src/lib/db.ts), а не HTTP API —
// это быстрее (нет HTTP overhead) и не требует CRON_SECRET для авторизации.
//
// Архитектура:
//   1. instrumentation.ts → startWorkerRuntime() (один раз при старте)
//   2. setTimeout poll-loop каждые WORKER_POLL_INTERVAL_MS (5 сек default)
//   3. Атомарный захват pending jobs через UPDATE...WHERE status='pending' RETURNING id
//      (SQLite/LibSQL поддерживает RETURNING — это атомарно)
//   4. Обработка каждого job через p-limit(WORKER_MAX_CONCURRENCY=5)
//   5. routeRequest(): 2ГИС → OSRM → haversine chain (import из src/lib/routing)
//   6. Запись результата в TrafficJob.result + Session.status='completed'
//   7. При ошибке: requeue с backoff (если attempts < 3) или status='dead'
//
// Идемпотентность: даже если запустится 2 instance (например HMR в dev),
// guard через globalThis.__workerRuntimeStarted предотвращает дубликат.

import pLimit from "p-limit";
import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { inc, set } from "./metrics";
import { routeRequest, type RouteResult } from "./routing/chain";

// === Guard against duplicate start (HMR, multiple instrumentation calls) ===
const GLOBAL_KEY = "__telemetriaWorkerRuntime";
const g = globalThis as unknown as { [GLOBAL_KEY]?: WorkerRuntime };

interface WorkerRuntime {
  startedAt: number;
  totalProcessed: number;
  totalFailed: number;
  inFlight: Set<string>;
  runningJobs: number;
  shuttingDown: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollIntervalMs: number;
  workerId: string;
  stop: () => void;
}

// === Types ===

interface JobRow {
  id: string;
  session_id: string;
  attempts: number;
}

interface GpsPointRow {
  lat: number;
  lon: number;
}

interface JobWithPoints {
  id: string;
  sessionId: string;
  attempts: number;
  session: {
    id: string;
    deviceId: string;
    gpsPoints: Array<{ lat: number; lon: number }>;
  };
}

// === Helpers ===

function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

function genRequestId(): string {
  return crypto.randomUUID();
}

// === Atomic job polling (UPDATE...RETURNING, SQLite-style) ===
// Атомарный захват: только один worker-instance может забрать job, потому что
// UPDATE...WHERE status='pending' выполняется под implicit transaction.
//
// Также reclaim'ит "stuck" running jobs — те, что lockedAt старше STUCK_TTL_MS
// (60 сек). Это нужно если предыдущий worker упал mid-job (OOM, restart, deploys).
async function pollJobs(
  workerId: string,
  batchSize: number,
  requestId: string
): Promise<JobWithPoints[]> {
  const now = new Date().toISOString();
  const STUCK_TTL_MS = 60_000; // 60 sec — job считается stuck если lockedAt старше
  const stuckCutoff = new Date(Date.now() - STUCK_TTL_MS).toISOString();

  // 0. Reclaim stuck running jobs (lockedBy != null AND lockedAt < cutoff)
  // Это атомарно: UPDATE...WHERE status='running' AND lockedAt < cutoff
  try {
    const reclaimResult = await libsql.execute({
      sql: `UPDATE TrafficJob
            SET status = 'pending', lockedBy = NULL, lockedAt = NULL, updatedAt = ?
            WHERE status = 'running' AND lockedAt < ?`,
      args: [now, stuckCutoff],
    });
    if (reclaimResult.rowsAffected > 0) {
      logger.warn("reclaimed stuck running jobs", {
        requestId,
        count: reclaimResult.rowsAffected,
        stuckTtlMs: STUCK_TTL_MS,
      });
    }
  } catch (err) {
    logger.warn("reclaim stuck jobs failed (non-fatal)", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 1. Atomic claim: UPDATE pending → running, RETURNING id
  // Note: libsql/SQLite хранит camelCase имена как есть (Prisma не цитирует их).
  const claimResult = await libsql.execute({
    sql: `UPDATE TrafficJob
          SET status = 'running', lockedBy = ?, lockedAt = ?, updatedAt = ?
          WHERE id IN (
            SELECT id FROM TrafficJob
            WHERE status = 'pending' AND scheduledFor <= ?
            ORDER BY priority DESC, scheduledFor ASC
            LIMIT ?
          )
          RETURNING id, sessionId, attempts`,
    args: [workerId, now, now, now, batchSize],
  });

  if (claimResult.rows.length === 0) {
    return [];
  }

  const claimed = claimResult.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      sessionId: String(row.sessionId),
      attempts: Number(row.attempts || 0),
    };
  });

  // 2. Load session + gpsPoints for each claimed job
  const jobs: JobWithPoints[] = [];
  for (const c of claimed) {
    const sessRes = await libsql.execute({
      sql: "SELECT id, deviceId FROM Session WHERE id = ?",
      args: [c.sessionId],
    });
    if (sessRes.rows.length === 0) {
      // session was deleted — mark job dead, skip
      await libsql.execute({
        sql: `UPDATE TrafficJob SET status = 'dead', error = 'session not found', updatedAt = ? WHERE id = ?`,
        args: [new Date().toISOString(), c.id],
      });
      logger.warn("job session missing, marked dead", { requestId, jobId: c.id, sessionId: c.sessionId });
      continue;
    }
    const sessRow = toCamel(sessRes.rows[0] as Record<string, unknown>);

    const ptsRes = await libsql.execute({
      sql: "SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
      args: [c.sessionId],
    });
    const gpsPoints = ptsRes.rows.map((r) => {
      const p = r as Record<string, unknown>;
      return { lat: Number(p.lat), lon: Number(p.lon) };
    });

    jobs.push({
      id: c.id,
      sessionId: c.sessionId,
      attempts: c.attempts,
      session: {
        id: String(sessRow.id),
        deviceId: String(sessRow.deviceId),
        gpsPoints,
      },
    });
  }

  return jobs;
}

// === Job completion (mirrors /api/worker/complete logic) ===
async function completeJob(
  jobId: string,
  status: "completed" | "failed",
  result: RouteResult | null,
  errorMsg: string | null,
  attempts: number,
  requestId: string
): Promise<void> {
  const now = new Date().toISOString();
  const newAttempts = attempts + 1;

  let finalStatus: string = status;
  let scheduledFor: string | null = null;
  let errorCol: string | null = errorMsg;
  let resultCol: string | null = result ? JSON.stringify(result) : null;

  if (status === "failed") {
    inc("traffic_job_failed_total", "Traffic jobs failed", 1);
    // Requeue with exponential backoff if attempts < 3
    if (newAttempts < 3) {
      const backoffMs = Math.pow(2, newAttempts) * 1000; // 2s, 4s
      finalStatus = "pending";
      scheduledFor = new Date(Date.now() + backoffMs).toISOString();
      errorCol = null; // clear error on requeue
      resultCol = null;
    } else {
      finalStatus = "dead";
    }
  } else if (status === "completed") {
    inc("traffic_job_completed_total", "Traffic jobs completed", 1);
  }

  // Update TrafficJob
  if (scheduledFor) {
    await libsql.execute({
      sql: `UPDATE TrafficJob
            SET status = ?, attempts = ?, error = ?, result = ?, scheduledFor = ?,
                lockedBy = NULL, lockedAt = NULL, updatedAt = ?
            WHERE id = ?`,
      args: [finalStatus, newAttempts, errorCol, resultCol, scheduledFor, now, jobId],
    });
  } else {
    await libsql.execute({
      sql: `UPDATE TrafficJob
            SET status = ?, attempts = ?, error = ?, result = ?,
                lockedBy = NULL, lockedAt = NULL, updatedAt = ?
            WHERE id = ?`,
      args: [finalStatus, newAttempts, errorCol, resultCol, now, jobId],
    });
  }

  // If completed: also update Session.status='completed' (if was 'recording' or 'processing')
  if (status === "completed") {
    await libsql.execute({
      sql: `UPDATE Session SET status = 'completed', updatedAt = ?
            WHERE id = (SELECT sessionId FROM TrafficJob WHERE id = ?)
              AND status IN ('recording', 'processing')`,
      args: [now, jobId],
    });
  }

  logger.info("job completed", {
    requestId,
    jobId,
    status: finalStatus,
    attempts: newAttempts,
    provider: result?.provider,
    distanceM: result?.distanceM,
    durationSec: result?.durationSec,
  });
}

// === Process one job (route chain) ===
async function processOneJob(job: JobWithPoints, parentRequestId: string): Promise<void> {
  const requestId = genRequestId();
  const points = job.session.gpsPoints;

  // Edge case: < 2 points
  if (!points || points.length < 2) {
    const emptyResult: RouteResult = {
      provider: "haversine",
      distanceM: 0,
      durationSec: 0,
      polyline: points.length === 1 ? [[points[0].lat, points[0].lon]] : [],
      segments: points.length === 1 ? [{ lat: points[0].lat, lon: points[0].lon }] : [],
      trafficFetched: false,
    };
    await completeJob(job.id, "completed", emptyResult, null, job.attempts, requestId);
    return;
  }

  const start = points[0];
  const end = points[points.length - 1];

  logger.info("job started", {
    requestId,
    parentRequestId,
    jobId: job.id,
    sessionId: job.sessionId,
    deviceId: job.session.deviceId,
    points: points.length,
  });

  try {
    // 1 attempt with 8s timeout. Retry delegated to requeue logic.
    const result = await Promise.race<RouteResult>([
      routeRequest(start.lat, start.lon, end.lat, end.lon),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("routeRequest timeout 8s")), 8000)
      ),
    ]);
    await completeJob(job.id, "completed", result, null, job.attempts, requestId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await completeJob(job.id, "failed", null, errMsg, job.attempts, requestId);
  }
}

// === Poll cycle ===
async function pollOnce(rt: WorkerRuntime): Promise<void> {
  const requestId = genRequestId();
  const t0 = Date.now();
  try {
    const jobs = await pollJobs(rt.workerId, env().WORKER_BATCH_SIZE, requestId);
    if (jobs.length === 0) return;

    logger.info("polled jobs", { requestId, workerId: rt.workerId, count: jobs.length });

    const limit = pLimit(env().WORKER_MAX_CONCURRENCY);
    await Promise.all(jobs.map((job) => limit(() => processOneJob(job, requestId))));

    const durMs = Date.now() - t0;
    logger.info("batch processed", { requestId, count: jobs.length, durationMs: durMs });
  } catch (err) {
    logger.error("poll cycle failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// === Public API ===

/**
 * Запускает in-process worker runtime. Идемпотентно: повторный вызов
 * возвращает уже запущенный runtime (безопасно для HMR).
 *
 * Вызывается из src/instrumentation.ts → register() при старте Next.js.
 */
export function startWorkerRuntime(): WorkerRuntime {
  if (g[GLOBAL_KEY]) {
    return g[GLOBAL_KEY]!;
  }

  const e = env();
  const rt: WorkerRuntime = {
    startedAt: Date.now(),
    totalProcessed: 0,
    totalFailed: 0,
    inFlight: new Set(),
    runningJobs: 0,
    shuttingDown: false,
    pollTimer: null,
    pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    workerId: e.WORKER_ID,
    stop: () => {
      rt.shuttingDown = true;
      if (rt.pollTimer) clearTimeout(rt.pollTimer);
      logger.info("worker runtime stopped", { workerId: rt.workerId });
    },
  };

  // Schedule poll loop
  const schedulePoll = (): void => {
    if (rt.shuttingDown) return;
    rt.pollTimer = setTimeout(async () => {
      try {
        await pollOnce(rt);
      } catch (err) {
        logger.error("pollOnce threw unexpectedly", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Update metrics gauge
      try {
        const pendingRes = await libsql.execute(
          "SELECT COUNT(*) as c FROM TrafficJob WHERE status = 'pending'"
        );
        const runningRes = await libsql.execute(
          "SELECT COUNT(*) as c FROM TrafficJob WHERE status = 'running'"
        );
        const pending = Number((pendingRes.rows[0] as Record<string, unknown>).c);
        const running = Number((runningRes.rows[0] as Record<string, unknown>).c);
        set("worker_pending_jobs", pending, "Pending traffic jobs in queue");
        set("worker_running_jobs", running, "Running traffic jobs");
      } catch {
        // ignore metrics error
      }
      schedulePoll();
    }, rt.pollIntervalMs);
  };

  g[GLOBAL_KEY] = rt;

  // Graceful shutdown hooks
  const shutdown = (signal: string): void => {
    if (rt.shuttingDown) return;
    logger.info("worker runtime shutting down", { signal, inFlight: rt.inFlight.size });
    rt.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info("worker runtime started (in-process)", {
    workerId: rt.workerId,
    pollIntervalMs: rt.pollIntervalMs,
    batchSize: e.WORKER_BATCH_SIZE,
    maxConcurrency: e.WORKER_MAX_CONCURRENCY,
    note: "runs inside Next.js process via instrumentation.ts",
  });

  // Start the poll loop (after first tick, so Next.js finishes booting)
  schedulePoll();

  return rt;
}

/**
 * Возвращает текущий runtime (или null, если не запущен).
 * Используется /api/worker/health для отчёта in-process worker state.
 */
export function getWorkerRuntime(): WorkerRuntime | null {
  return g[GLOBAL_KEY] ?? null;
}
