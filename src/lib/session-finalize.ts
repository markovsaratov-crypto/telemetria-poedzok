// src/lib/session-finalize.ts — финализация сессий и TrafficJob (shared).
// v2.14.0 (Ф3): вынесено из src/app/api/ingest/sensorlogger/route.ts, чтобы
// воркер мог закрывать зависшие recording-сессии («жнец» в worker-runtime.ts)
// ТОЙ ЖЕ логикой, что и инжест при разрыве >60с.
//
// v2.16.0 (R3): атомарная защита от ДУБЛЕЙ TrafficJob. Раньше INSERT был
// безусловным, а у TrafficJob.sessionId нет unique-констрейнта: ТРИ гонящихся
// финализатора (инжест gap>60с, cron finalize-sessions, воркер-«жнец») могли
// наминтить по pending-джобу каждый → двойные вызовы 2GIS/OSRM и мусорные
// строки. Теперь вставка — единый `INSERT … SELECT … WHERE NOT EXISTS`
// (pending/running джоба у сессии), а флаг «наш ли это переход recording→
// completed» определяется rowsAffected самого UPDATE статуса.
import { libsql } from "./db";
import { logger } from "./logger";

/**
 * Гарантирует наличие TrafficJob для сессии. Вставляет pending-джоб ТОЛЬКО если
 * у сессии нет живого (pending/running) джоба — атомарно одним SQL-стейтментом.
 * Ссылка Session.trafficJobId проставляется на последний джоб сессии, если NULL.
 */
export async function ensureTrafficJob(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  try {
    await libsql.execute({
      sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, createdAt, updatedAt)
            SELECT ?, ?, 'pending', 0, 0, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE sessionId = ? AND status IN ('pending', 'running'))`,
      args: [jobId, sessionId, now, now, sessionId],
    });
  } catch (err) {
    // Сбой вставки не должен ронять финализацию: сессия уже закрыта, джоб
    // добит повтором (cron/reaper) или requeue-админом.
    logger.warn("TrafficJob insert failed (non-fatal)", {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  // Ссылку ставим на последний по времени джоб сессии (вставленный ИЛИ уже
  // существующий), если она ещё не проставлена.
  await libsql.execute({
    sql: `UPDATE Session SET trafficJobId = COALESCE(
            (SELECT id FROM TrafficJob WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId),
            updatedAt = ?
          WHERE id = ? AND trafficJobId IS NULL`,
    args: [sessionId, now, sessionId],
  }).catch(() => null);
}

/**
 * Финализация сессии: recording → completed + TrafficJob.
 * Вызывается из инжеста (gap >60с), cron finalize-sessions и воркера-«жнеца».
 * Идемпотентна: повторный вызов для уже-completed сессии не чинит статус
 * (rowsAffected = 0) и не дублирует pending-джоб (см. ensureTrafficJob).
 */
export async function finalizeSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  await ensureTrafficJob(sessionId);
  logger.info("Session finalized", { sessionId });
}
