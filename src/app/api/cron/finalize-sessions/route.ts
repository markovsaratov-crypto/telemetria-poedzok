// POST /api/cron/finalize-sessions — финализирует recording-сессии, которые не обновлялись > 60с.
// SensorLogger шлёт батчи каждые 1с; если батчей нет 60с — запись закончена.
// Auth: Bearer CRON_SECRET  ИЛИ  ?token=CRON_SECRET
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { extractBearer } from "@/lib/auth";
import { tokenMatches } from "@/lib/token-check"; // AUDIT B-16: timing-safe сравнение
import { env } from "@/lib/env";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";

const STALE_MS = 60_000; // 60с без батча = запись закончена

async function finalizeOne(sessionId: string): Promise<string | null> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  // v2.11.0 (АУДИТ C-9): при сбое вставки джоба — находим существующий,
  // чтобы trafficJobId не указывал на несуществующий джоб
  const jobId = randomUUID();
  let ok = true;
  try {
    await libsql.execute({
      sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, createdAt, updatedAt)
            VALUES (?, ?, 'pending', 0, 0, ?, ?)`,
      args: [jobId, sessionId, now, now],
    });
  } catch {
    ok = false;
  }
  if (ok) {
    await libsql.execute({
      sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
      args: [jobId, now, sessionId],
    }).catch(() => null);
    return jobId;
  }
  const existing = await libsql.execute({
    sql: `SELECT id FROM TrafficJob WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 1`,
    args: [sessionId],
  });
  if (existing.rows.length > 0) {
    const exId = String((existing.rows[0] as Record<string, unknown>).id);
    await libsql.execute({
      sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
      args: [exId, now, sessionId],
    }).catch(() => null);
    return exId;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    const bearer = extractBearer(request);
    const e = env();
    // AUDIT B-16: timing-safe сравнение (раньше ===)
    const tokenOk =
      (await tokenMatches(bearer, e.CRON_SECRET)) ||
      (await tokenMatches(queryToken, e.CRON_SECRET)) ||
      (await tokenMatches(bearer, e.ADMIN_TOKEN)) ||
      (await tokenMatches(queryToken, e.ADMIN_TOKEN));
    if (!tokenOk) {
      return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
    }

    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const stale = await libsql.execute({
      sql: `SELECT id FROM Session
            WHERE status = 'recording' AND deletedAt IS NULL AND updatedAt < ?
            ORDER BY updatedAt ASC LIMIT 100`,
      args: [cutoff],
    });

    const finalized: string[] = [];
    for (const row of stale.rows) {
      const sessionId = (row as Record<string, unknown>).id as string;
      await finalizeOne(sessionId);
      finalized.push(sessionId);
    }

    if (finalized.length > 0) {
      logger.info("Cron finalize-sessions", { count: finalized.length, sessionIds: finalized });
    }
    return json(
      { ok: true, finalized: finalized.length, sessionIds: finalized, cutoffMs: STALE_MS },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Cron finalize-sessions error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(
      { error: "Internal Server Error", message: err instanceof Error ? err.message : String(err) },
      500,
      { "X-Request-Id": requestId }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
