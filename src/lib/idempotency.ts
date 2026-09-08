// src/lib/idempotency.ts — проверка (deviceId, clientId), возврат существующего sessionId (§6.2)
// v2.23.0: userId — изоляция данных: дубликат ищется только среди сессий того же
// владельца (глобальный ключ (deviceId, clientId) остаётся уникальным — см. generic ingest)
import { db, libsql } from "./db";

export async function findExistingSession(deviceId: string, clientId: string, userId?: string | null) {
  // v2.23.0: скоуп по владельцу — сырой SQL вместо composite findUnique
  const res = await libsql.execute({
    sql: `SELECT id, status, deletedAt FROM Session
          WHERE deviceId = ? AND clientId = ? ${userId ? "AND userId = ?" : "AND userId IS NULL"} LIMIT 1`,
    args: userId ? [deviceId, clientId, userId] : [deviceId, clientId],
  });
  const existing = res.rows.length > 0 ? res.rows[0] as Record<string, unknown> : null;
  if (!existing) return null;
  // Soft-deleted сессия занимает уникальную пару (deviceId, clientId):
  // помечаем старый clientId надгробием и освобождаем пару —
  // повторный пакет создаёт НОВУЮ сессию (§6.3), история сохраняется.
  if (existing.deletedAt) {
    await db.session.update({
      where: { id: String(existing.id) }, // v2.18.0: типизированный db
      data: { clientId: `${clientId}#deleted#${String(existing.id).slice(0, 8)}` }, // existing.id: String — типизированный db
    });
    return null;
  }
  return existing.id;
}
