// index.ts — Worker mini-service entry point (§9.6, §9.7).

// Bun runtime global (worker runs under bun --hot; @types/bun не в зависимостях)
declare const Bun: { serve(cfg: Record<string, unknown>): { port: number; fetch: unknown; stop(force?: boolean): void }; env: Record<string, string | undefined>; };
//
// ИЗОЛЯЦИЯ ПРОЦЕССА (§9.6 anti-pattern: shared event loop):
// Worker — это полностью отдельный процесс (Bun), не разделяет event loop
// с Next.js. Worker НЕ имеет прямого доступа к БД — только через API на
// порту 3000 (Bearer CRON_SECRET).
//
// Аргитектура:
//   1. Bun.serve на порту 3001 (HTTP health endpoint + CORS)
//   2. Poll-цикл каждые WORKER_POLL_INTERVAL_MS (5 сек default)
//      → POST /api/worker/poll { workerId, batchSize }
//      → получает jobs[] (TrafficJob + session.gpsPoints)
//   3. Обработка каждого job через p-limit(WORKER_MAX_CONCURRENCY=5)
//   4. Результат → POST /api/worker/complete { jobId, status, result?|error? }
//   5. При ошибке processor бросает — Worker шлёт status="failed",
//      API само решает requeue с backoff (если attempts < 3) или dead.

import pLimit from "p-limit";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processJob, type RouteResult, type TrafficJobLike } from "./processor";
import { runBackupIfNeeded } from "./backup-runner";

// === .env loader (читает ../../.env если запущен из mini-services/worker/) ===
// Bun auto-load ищет .env в cwd. Если worker запущен из своей директории,
// .env отсутствует — подгружаем вручную из корня проекта.
function loadEnvFile(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // не перезаписываем существующие env vars (env > .env file)
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
    break;
  }
}
loadEnvFile();

// === Env (worker-local, no main project imports) ===
const WORKER_ID = process.env.WORKER_ID || "worker-local";
const CRON_SECRET = process.env.CRON_SECRET || "";
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 10;
const MAX_CONCURRENCY = Number(process.env.WORKER_MAX_CONCURRENCY) || 5;
const API_BASE = process.env.WORKER_API_BASE || "http://localhost:3000";
const PORT = 3001; // §9.6: жёстко задано, НЕ через PORT env

if (!CRON_SECRET || CRON_SECRET.length < 32) {
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      msg: "CRON_SECRET missing or < 32 chars — worker cannot authenticate to API",
    })
  );
  process.exit(1);
}

// === JSON logger to stdout (Pino-like, requestId-scoped) ===
type LogLevel = "debug" | "info" | "warn" | "error";
type LogCtx = Record<string, unknown>;

function log(level: LogLevel, msg: string, ctx: LogCtx = {}): void {
  const entry = { time: new Date().toISOString(), level, msg, ...ctx };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// === State ===
let runningJobs = 0;
let totalProcessed = 0;
let totalFailed = 0;
let shuttingDown = false;
const inFlight = new Set<string>();
const startedAt = Date.now();

const limit = pLimit(MAX_CONCURRENCY);

// === Helpers ===
function genRequestId(): string {
  return crypto.randomUUID();
}

async function callApi(path: string, body: unknown, requestId: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CRON_SECRET}`,
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchApiHealth(
  requestId: string
): Promise<{ pendingJobs: number; runningJobs: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/worker/health`, {
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "X-Request-Id": requestId,
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pendingJobs?: number; runningJobs?: number };
    return {
      pendingJobs: data.pendingJobs ?? 0,
      runningJobs: data.runningJobs ?? 0,
    };
  } catch {
    return null;
  }
}

// === Job processing ===
type JobFromPoll = TrafficJobLike;

interface PollResponse {
  jobs: JobFromPoll[];
}

async function pollOnce(): Promise<void> {
  const requestId = genRequestId();
  const t0 = Date.now();
  try {
    const data = (await callApi(
      "/api/worker/poll",
      { workerId: WORKER_ID, batchSize: BATCH_SIZE },
      requestId
    )) as PollResponse;
    const jobs = data.jobs || [];
    if (jobs.length === 0) return; // idle — тихо
    log("info", "polled jobs", {
      requestId,
      workerId: WORKER_ID,
      count: jobs.length,
    });
    // Обрабатываем пакет параллельно через p-limit
    await Promise.all(jobs.map((job) => limit(() => processOneJob(job, requestId))));
    const durMs = Date.now() - t0;
    log("info", "batch processed", { requestId, count: jobs.length, durationMs: durMs });
  } catch (err) {
    log("error", "poll cycle failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function processOneJob(job: JobFromPoll, parentRequestId: string): Promise<void> {
  const requestId = genRequestId();
  const jobId = job.id;
  inFlight.add(jobId);
  runningJobs += 1;
  const t0 = Date.now();
  log("info", "job started", {
    requestId,
    parentRequestId,
    workerId: WORKER_ID,
    jobId,
    sessionId: job.sessionId,
    deviceId: job.session.deviceId,
    points: job.session.gpsPoints.length,
  });
  let result: RouteResult;
  try {
    // 1 попытка с timeout 8 сек внутри processJob.
    // Retry делегирован API (status="failed" → backoff там).
    result = await processJob(job);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    totalFailed += 1;
    const durationMs = Date.now() - t0;
    try {
      await callApi(
        "/api/worker/complete",
        { jobId, status: "failed", error: errMsg },
        requestId
      );
    } catch (completeErr) {
      log("error", "failed to report job failure", {
        requestId,
        jobId,
        error: completeErr instanceof Error ? completeErr.message : String(completeErr),
      });
    }
    log("warn", "job failed", {
      requestId,
      workerId: WORKER_ID,
      jobId,
      error: errMsg,
      durationMs,
    });
    inFlight.delete(jobId);
    runningJobs -= 1;
    return;
  }
  try {
    await callApi(
      "/api/worker/complete",
      { jobId, status: "completed", result },
      requestId
    );
    totalProcessed += 1;
    const durationMs = Date.now() - t0;
    log("info", "job completed", {
      requestId,
      workerId: WORKER_ID,
      jobId,
      provider: result.provider,
      distanceM: result.distanceM,
      durationSec: result.durationSec,
      trafficFetched: result.trafficFetched,
      trafficUtc: result.trafficUtc,
      // v2.9: новые поля
      routeHash: result.routeHash ?? null,
      topologyHash: result.topologyHash ?? null,
      activeTrip: result.metrics?.activeTrip ?? null,
      ecoScore: result.metrics?.ecoScore.value ?? null,
      sessionReliability: result.metrics?.sessionReliability.value ?? null,
      mapMatchLogProb: result.mapMatchLogProb ?? null,
      durationMs,
    });
  } catch (completeErr) {
    // Job обработан, но не смогли доставить результат — API покажет stuck running.
    // На следующем poll-цикле API имеет TTL для lockedAt (см. spec §9.7).
    totalFailed += 1;
    log("error", "failed to report job completion", {
      requestId,
      workerId: WORKER_ID,
      jobId,
      provider: result.provider,
      error: completeErr instanceof Error ? completeErr.message : String(completeErr),
    });
  } finally {
    inFlight.delete(jobId);
    runningJobs -= 1;
  }
}

// === Poll loop ===
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (shuttingDown) return;
  pollTimer = setTimeout(async () => {
    try {
      await pollOnce();
    } catch (err) {
      log("error", "pollOnce threw unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // also tick backup runner (stub)
    try {
      await runBackupIfNeeded();
    } catch (err) {
      log("warn", "backup runner error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    schedulePoll();
  }, POLL_INTERVAL_MS);
}

// === HTTP server (Bun.serve) на порту 3001 ===
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
  "Access-Control-Max-Age": "86400",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /health?XTransformPort=3001
    if (req.method === "GET" && url.pathname === "/health") {
      const requestId = req.headers.get("x-request-id") || genRequestId();
      const apiHealth = await fetchApiHealth(requestId);
      const body = {
        status: "ok",
        workerId: WORKER_ID,
        pendingJobs: apiHealth?.pendingJobs ?? 0,
        runningJobs: runningJobs, // worker's local in-flight count
        inFlight: inFlight.size,
        apiRunningJobs: apiHealth?.runningJobs ?? null, // DB-level running (для сверки)
        totalProcessed,
        totalFailed,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        version: "2.9.0",
      };
      return Response.json(body, {
        status: 200,
        headers: { ...CORS_HEADERS, "X-Request-Id": requestId },
      });
    }

    return Response.json(
      { error: "Not Found", path: url.pathname },
      { status: 404, headers: CORS_HEADERS }
    );
  },
});

log("info", "worker started", {
  workerId: WORKER_ID,
  port: PORT,
  apiBase: API_BASE,
  pollIntervalMs: POLL_INTERVAL_MS,
  batchSize: BATCH_SIZE,
  maxConcurrency: MAX_CONCURRENCY,
});

// === Graceful shutdown (SIGINT/SIGTERM) ===
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "worker shutting down", {
    signal,
    inFlight: inFlight.size,
    totalProcessed,
    totalFailed,
  });
  if (pollTimer) clearTimeout(pollTimer);

  // Даём in-flight jobs до 10 секунд на завершение
  const t0 = Date.now();
  while (inFlight.size > 0 && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (inFlight.size > 0) {
    log("warn", "worker stopping with in-flight jobs", { remaining: inFlight.size });
  }

  server.stop(true);
  log("info", "worker stopped", { signal });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// старт poll-цикла
schedulePoll();
