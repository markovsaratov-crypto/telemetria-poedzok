// src/lib/session-finalize.ts — финализация сессий и TrafficJob (shared).
// v2.14.0 (Ф3): вынесено из src/app/api/ingest/sensorlogger/route.ts, чтобы
// воркер мог закрывать зависшие recording-сессии («жнец» в worker-runtime.ts)
// ТОЙ ЖЕ логикой, что и инжест при разрыве >60с. Поведение не менялось —
// код скопирован дословно, только crypto import заменён на глобальный
// webcrypto (Edge-safe, доступен и в Node 18+; см. шапку worker-runtime.ts
// про Edge-бандл instrumentation.ts — этот файл входит в него транзитивно).
import { libsql } from "./db";
import { logger } from "./logger";

// v2.11.0 (АУДИТ C-9): финализация + TrafficJob без «висячего» trafficJobId.
// Раньше .catch(()=>{}) глотал ЛЮБЫЕ ошибки вставки джоба, а UPDATE всё равно
// прописывал trafficJobId = jobId несуществующего джоба → сессия без маршрутизации.
// Теперь: вставка с проверкой — при дубликате/ошибке находим существующий джоб сессии.
export async function ensureTrafficJob(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  let inserted = false;
  try {
    await libsql.execute({
      sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, createdAt, updatedAt)
            VALUES (?, ?, 'pending', 0, 0, ?, ?)`,
      args: [jobId, sessionId, now, now],
    });
    inserted = true;
  } catch (err) {
    logger.warn("TrafficJob insert failed — ищем существующий", {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (inserted) {
    await libsql.execute({
      sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
      args: [jobId, now, sessionId],
    });
  } else {
    const existing = await libsql.execute({
      sql: `SELECT id FROM TrafficJob WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 1`,
      args: [sessionId],
    });
    if (existing.rows.length > 0) {
      const exId = String((existing.rows[0] as Record<string, unknown>).id);
      await libsql.execute({
        sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
        args: [exId, now, sessionId],
      });
    }
  }
}

// Финализация сессии: recording → completed + TrafficJob.
// Вызывается из инжеста (gap >60с) и из воркера-«жнеца» (тишина >10 мин).
export async function finalizeSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  // v2.11.0 (АУДИТ C-9): TrafficJob с защитой от дублей и висячих ссылок
  await ensureTrafficJob(sessionId);
  logger.info("Session finalized", { sessionId });
}
