// src/lib/worker-runtime.ts — In-process Worker (runs inside Next.js via instrumentation.ts).
import pLimit from "p-limit";
import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { inc, set } from "./metrics";
import { routeRequest } from "./routing/chain";

// P0-фикс v2.9.10 (Render build failure — финальная версия без костылей):
//
// КОРНЕВАЯ ПРИЧИНА цепочки ошибок билда на Render:
//  1) (v2.9.8, стабильно) env().EXPORT_STORAGE_DIR протекал в path.join →
//     Turbopack warning "Dynamic filesystem access causes tracing of the
//     whole project" → build failed.
//  2) (v2.9.9 PR #19, изначально мержённый но упал на билде)
//  3) (первая попытка v2.9.10, commit 58ac9ad) — добавил top-level
//     `import fs from "fs"` / `import path from "path"` в этот файл →
//     Edge Runtime (middleware.ts) бандлит instrumentation.ts + его
//     динамический import этого файла → Edge не поддерживает Node.js
//     fs/path → "A Node.js module is loaded which is not supported in
//     the Edge Runtime" → build failed (line 4).
//  4) (вторая попытка v2.9.10, commit e914d0c) — заменил top-level
//     импорты на динамические `await import("fs")` / `await import("path")`
//     ВНУТРИ pollExportJobs — но Turbopack-у всё равно видно ссылки на
//     `path`/`fs` и он пытается их бандлить для Edge → та же ошибка
//     на line 250 (const path = await import("path")).
//
// ПРАВИЛЬНЫЙ ФИКС без костылей:
// Убрать fs/path операции ИЗ ЭТОГО ФАЙЛА ВООБЩЕ. Запись файла экспорта
// в pollExportJobs была бесполезна — download-роут
// /api/exports/[jobId]/download (см. src/app/api/exports/[jobId]/download/
// route.ts:28-29) регенерирует контент на лету через generateExport() из
// сессии в БД, а НЕ читает файл с диска. Сохраняем только метаданные в БД
// (fileSize, expiresAt, фиктивный fileUrl для совместимости со схемой).
// export.ts не использует fs/path — чистая функция, edge-совместимая.
// const EXPORT_STORAGE_DIR больше не нужен.
//
// backup.ts остаётся с fs-операциями — он НЕ загружается через
// instrumentation.ts (только через /api/admin/backup* API-роуты, у которых
// runtime=nodejs по умолчанию в Next.js 16) → Edge-bundle его не видит.
// В backup.ts path/fs импортированы статически на top-level (как в
// оригинале) — это безопасно.

const GLOBAL_KEY = "__telemetriaWorkerRuntime";
const g = globalThis as unknown as { [GLOBAL_KEY]?: WorkerRuntime };

interface WorkerRuntime {
  startedAt: number;
  inFlight: Set<string>;
  shuttingDown: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollIntervalMs: number;
  workerId: string;
  stop: () => void;
}

function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

interface JobWithPoints {
  id: string;
  sessionId: string;
  attempts: number;
  session: { id: string; deviceId: string; gpsPoints: Array<{ lat: number; lon: number }> };
}

async function pollJobs(workerId: string, batchSize: number): Promise<JobWithPoints[]> {
  const now = new Date().toISOString();
  const STUCK_TTL_MS = 60_000;
  const stuckCutoff = new Date(Date.now() - STUCK_TTL_MS).toISOString();

  // Reclaim stuck running jobs
  try {
    await libsql.execute({
      sql: `UPDATE TrafficJob SET status = 'pending', lockedBy = NULL, lockedAt = NULL, updatedAt = ? WHERE status = 'running' AND lockedAt < ?`,
      args: [now, stuckCutoff],
    });
  } catch {}

  // Atomic claim
  const claimResult = await libsql.execute({
    sql: `UPDATE TrafficJob SET status = 'running', lockedBy = ?, lockedAt = ?, updatedAt = ?
          WHERE id IN (SELECT id FROM TrafficJob WHERE status = 'pending' AND scheduledFor <= ? ORDER BY priority DESC, scheduledFor ASC LIMIT ?)
          RETURNING id, sessionId, attempts`,
    args: [workerId, now, now, now, batchSize],
  });

  if (claimResult.rows.length === 0) return [];

  const claimed = claimResult.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { id: String(row.id), sessionId: String(row.sessionId), attempts: Number(row.attempts || 0) };
  });

  // Batch load sessions + gpsPoints
  const sessionIds = claimed.map((c) => c.sessionId);
  const placeholders = sessionIds.map(() => "?").join(",");

  const sessionsRes = await libsql.execute({
    sql: `SELECT id, deviceId FROM Session WHERE id IN (${placeholders})`,
    args: sessionIds as any,
  });
  const sessionMap = new Map<string, string>();
  for (const r of sessionsRes.rows) {
    const row = r as Record<string, unknown>;
    sessionMap.set(String(row.id), String(row.deviceId));
  }

  const ptsRes = await libsql.execute({
    sql: `SELECT sessionId, lat, lon, speed FROM GpsPoint WHERE sessionId IN (${placeholders}) ORDER BY sessionId, timestamp ASC`,
    args: sessionIds as any,
  });
  const pointsMap = new Map<string, Array<{ lat: number; lon: number; speed: number | null }>>();
  for (const r of ptsRes.rows) {
    const p = r as Record<string, unknown>;
    const sid = String(p.sessionId);
    if (!pointsMap.has(sid)) pointsMap.set(sid, []);
    pointsMap.get(sid)!.push({ lat: Number(p.lat), lon: Number(p.lon), speed: p.speed != null ? Number(p.speed) : null });
  }

  const jobs: JobWithPoints[] = [];
  for (const c of claimed) {
    const deviceId = sessionMap.get(c.sessionId);
    if (!deviceId) {
      await libsql.execute({ sql: `UPDATE TrafficJob SET status = 'dead', error = 'session not found', updatedAt = ? WHERE id = ?`, args: [now, c.id] });
      continue;
    }
    const allPoints = pointsMap.get(c.sessionId) || [];
    // Filter: active part = first speed>0 to last speed>0
    let firstActive = -1, lastActive = -1;
    for (let i = 0; i < allPoints.length; i++) {
      if (allPoints[i].speed != null && allPoints[i].speed! > 0) {
        if (firstActive === -1) firstActive = i;
        lastActive = i;
      }
    }
    const gpsPoints = firstActive >= 0
      ? allPoints.slice(firstActive, lastActive + 1).map((p) => ({ lat: p.lat, lon: p.lon }))
      : allPoints.map((p) => ({ lat: p.lat, lon: p.lon }));

    jobs.push({ id: c.id, sessionId: c.sessionId, attempts: c.attempts, session: { id: c.sessionId, deviceId, gpsPoints } });
  }
  return jobs;
}

async function completeJob(jobId: string, status: "completed" | "failed", result: any, errorMsg: string | null, attempts: number, requestId: string) {
  const now = new Date().toISOString();
  const newAttempts = attempts + 1;
  let finalStatus: string = status;
  let scheduledFor: string | null = null;

  if (status === "failed") {
    inc("traffic_job_failed_total", "Traffic jobs failed", 1);
    if (newAttempts < 3) {
      const backoffMs = Math.pow(2, newAttempts) * 1000;
      finalStatus = "pending";
      scheduledFor = new Date(Date.now() + backoffMs).toISOString();
    } else {
      finalStatus = "dead";
    }
  } else {
    inc("traffic_job_completed_total", "Traffic jobs completed", 1);
  }

  if (scheduledFor) {
    await libsql.execute({
      sql: `UPDATE TrafficJob SET status = ?, attempts = ?, error = ?, result = ?, scheduledFor = ?, lockedBy = NULL, lockedAt = NULL, updatedAt = ? WHERE id = ?`,
      args: [finalStatus, newAttempts, errorMsg, result ? JSON.stringify(result) : null, scheduledFor, now, jobId],
    });
  } else {
    await libsql.execute({
      sql: `UPDATE TrafficJob SET status = ?, attempts = ?, error = ?, result = ?, lockedBy = NULL, lockedAt = NULL, updatedAt = ? WHERE id = ?`,
      args: [finalStatus, newAttempts, errorMsg, result ? JSON.stringify(result) : null, now, jobId],
    });
  }

  if (status === "completed") {
    await libsql.execute({
      sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = (SELECT sessionId FROM TrafficJob WHERE id = ?) AND status IN ('recording', 'processing')`,
      args: [now, jobId],
    });
  }
  logger.info("job completed", { requestId, jobId, status: finalStatus, attempts: newAttempts, provider: result?.provider, distanceM: result?.distanceM, durationSec: result?.durationSec });
}

async function processOneJob(job: JobWithPoints, parentRequestId: string) {
  const requestId = crypto.randomUUID();
  const points = job.session.gpsPoints;
  if (points.length < 2) {
    await completeJob(job.id, "completed", { provider: "haversine", distanceM: 0, durationSec: 0, polyline: [], segments: [], trafficFetched: false }, null, job.attempts, requestId);
    return;
  }
  const start = points[0];
  const end = points[points.length - 1];
  logger.info("job started", { requestId, parentRequestId, jobId: job.id, sessionId: job.sessionId, points: points.length });
  try {
    const result = await Promise.race<any>([
      routeRequest(start.lat, start.lon, end.lat, end.lon),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("routeRequest timeout 15s")), 15000)),
    ]);
    await completeJob(job.id, "completed", result, null, job.attempts, requestId);
  } catch (err) {
    await completeJob(job.id, "failed", null, err instanceof Error ? err.message : String(err), job.attempts, requestId);
  }
}

async function pollOnce(rt: WorkerRuntime) {
  const requestId = crypto.randomUUID();
  try {
    const jobs = await pollJobs(rt.workerId, env().WORKER_BATCH_SIZE);
    if (jobs.length > 0) {
      logger.info("polled jobs", { requestId, workerId: rt.workerId, count: jobs.length });
      const limit = pLimit(env().WORKER_MAX_CONCURRENCY);
      await Promise.all(jobs.map((job) => limit(() => processOneJob(job, requestId))));
    }
  } catch (err) {
    logger.error("poll cycle failed", { requestId, error: err instanceof Error ? err.message : String(err) });
  }
  // P1-8: обработка ExportJob (раньше навсегда оставались pending → «вечные 202»)
  try {
    await pollExportJobs();
  } catch (err) {
    logger.error("export poll failed", { requestId, error: err instanceof Error ? err.message : String(err) });
  }
}

// P1-8: обработка ExportJob (раньше навсегда оставались pending → «вечные 202»).
// v2.9.10: запись файла на диск убрана (download-роут регенерирует контент
// на лету через generateExport). Worker только генерирует контент, считает
// размер и обновляет метаданные в БД (fileSize, expiresAt).
async function pollExportJobs(): Promise<void> {
  const now = new Date().toISOString();
  const claim = await libsql.execute({
    sql: `UPDATE ExportJob SET status = 'running', updatedAt = ?
          WHERE id IN (SELECT id FROM ExportJob WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 2)
          RETURNING id, sessionId, format, attempts`,
    args: [now],
  });
  if (claim.rows.length === 0) return;

  for (const r of claim.rows) {
    const row = r as Record<string, unknown>;
    const jobId = String(row.id);
    const sessionId = String(row.sessionId);
    const format = String(row.format) as "gpx" | "kml" | "json";
    const attempts = Number(row.attempts || 0);
    try {
      const sessionRes = await libsql.execute({
        sql: `SELECT * FROM Session WHERE id = ?`,
        args: [sessionId],
      });
      if (sessionRes.rows.length === 0) throw new Error("session not found");
      const session = toCamel(sessionRes.rows[0] as Record<string, unknown>);
      const ptsRes = await libsql.execute({
        sql: `SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC`,
        args: [sessionId],
      });
      session.gpsPoints = ptsRes.rows.map((p) => toCamel(p as Record<string, unknown>));

      const { generateExport } = await import("./export");
      const { content, ext } = generateExport(session as never, format);
      // P0-фикс v2.9.10: запись файла экспорта на диск УБРАНА — она была
      // бесполезна (download-роут регенерирует контент через generateExport()
      // из сессии в БД, файл с диска не читается). Теперь worker-runtime.ts
      // не содержит fs/path импортов вообще → Edge-bundle чистый → build OK.
      // Сохраняем только метаданные в БД (fileSize, expiresAt). fileUrl
      // хранит логический путь (для совместимости со схемой и логами), но
      // это просто строка — fs-операций по ней нет.
      const logicalFileRef = `export://${jobId}.${ext}`;
      // v2.11.0 (АУДИТ C-4): expiresAt — ISO-строка (было число epoch-ms:
      // в SQLite integer < text → сравнения «истёк/не истёк» ломались).
      const expiresAt = new Date(Date.now() + env().EXPORT_URL_TTL_HOURS * 3600 * 1000).toISOString();
      await libsql.execute({
        sql: `UPDATE ExportJob SET status = 'completed', fileUrl = ?, fileSize = ?, expiresAt = ?, completedAt = ?, error = NULL, updatedAt = ? WHERE id = ?`,
        args: [logicalFileRef, Buffer.byteLength(content), expiresAt, now, now, jobId],
      });
      inc("export_completed_total", "Exports completed", 1, format);
      logger.info("export job completed", { jobId, sessionId, format, bytes: Buffer.byteLength(content) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const newAttempts = attempts + 1;
      const nextStatus = newAttempts < 3 ? "pending" : "dead";
      await libsql.execute({
        sql: `UPDATE ExportJob SET status = ?, attempts = ?, error = ?, updatedAt = ? WHERE id = ?`,
        args: [nextStatus, newAttempts, msg.slice(0, 500), now, jobId],
      });
      inc("export_failed_total", "Export jobs failed", 1);
      logger.error("export job failed", { jobId, error: msg, attempts: newAttempts });
    }
  }
}

export function startWorkerRuntime(): WorkerRuntime {
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY]!;
  const e = env();
  const rt: WorkerRuntime = {
    startedAt: Date.now(),
    inFlight: new Set(),
    shuttingDown: false,
    pollTimer: null,
    pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    workerId: e.WORKER_ID,
    stop: () => { rt.shuttingDown = true; if (rt.pollTimer) clearTimeout(rt.pollTimer); logger.info("worker runtime stopped", { workerId: rt.workerId }); },
  };

  const schedulePoll = () => {
    if (rt.shuttingDown) return;
    rt.pollTimer = setTimeout(async () => {
      try { await pollOnce(rt); } catch (err) { logger.error("pollOnce threw", { error: err instanceof Error ? err.message : String(err) }); }
      // Adaptive polling + metrics
      let nextInterval = 5000;
      try {
        const countsRes = await libsql.execute("SELECT status, COUNT(*) as c FROM TrafficJob WHERE status IN ('pending','running') GROUP BY status");
        let pending = 0, running = 0;
        for (const r of countsRes.rows) {
          const row = r as Record<string, unknown>;
          if (row.status === "pending") pending = Number(row.c);
          else if (row.status === "running") running = Number(row.c);
        }
        set("worker_pending_jobs", pending, "Pending traffic jobs");
        set("worker_running_jobs", running, "Running traffic jobs");
        if (pending === 0 && running === 0) nextInterval = 30000;
        else if (pending > 10) nextInterval = 2000;
        else nextInterval = 5000;
      } catch {}
      rt.pollIntervalMs = nextInterval;
      schedulePoll();
    }, rt.pollIntervalMs);
  };

  g[GLOBAL_KEY] = rt;
  // v2.9.10: process.on("SIGTERM"/"SIGINT") УБРАН — Turbopack хардкодит
  // Edge-бандл instrumentation.ts (см. коммент в начале этого файла и в
  // instrumentation.ts), а process.on — Node.js API, не поддерживается в
  // Edge Runtime → "Ecmascript file had an error" → build failed.
  // Грейсфул-шатдаун не критичен: воркер in-process, при SIGTERM/SIGINT
  // операционка убивает весь процесс Next.js, pollTimer (setTimeout) умирает
  // вместе с ним, никаких утечек. rt.stop() только чистил таймер и логировал.
  logger.info("worker runtime started (in-process)", { workerId: rt.workerId, pollIntervalMs: rt.pollIntervalMs });
  schedulePoll();
  return rt;
}

export function getWorkerRuntime(): WorkerRuntime | null {
  return g[GLOBAL_KEY] ?? null;
}
