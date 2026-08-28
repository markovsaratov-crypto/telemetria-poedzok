// src/lib/finalize-session.ts — shared session finalization logic.
import { libsql } from "./db";
import { logger } from "./logger";
import { randomUUID } from "crypto";

export async function finalizeSession(sessionId: string): Promise<string | null> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  const jobId = randomUUID();
  await libsql.execute({
    sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, scheduledFor, createdAt, updatedAt)
          VALUES (?, ?, 'pending', 0, 0, ?, ?, ?)`,
    args: [jobId, sessionId, now, now, now],
  }).catch((err) => {
    logger.warn("TrafficJob creation failed (non-fatal)", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  await libsql.execute({
    sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
    args: [jobId, now, sessionId],
  }).catch(() => null);
  logger.info("Session finalized", { sessionId, trafficJobId: jobId });
  return jobId;
}
