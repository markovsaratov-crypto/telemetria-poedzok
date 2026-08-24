// src/lib/idempotency.ts — проверка (deviceId, clientId), возврат существующего sessionId (§6.7)
import { db } from "./db";

export async function findExistingSession(deviceId: string, clientId: string) {
  const existing = await db.session.findUnique({
    where: {
      deviceId_clientId: { deviceId, clientId },
    },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!existing) return null;
  // Если сессия soft-deleted, не считаем дубликатом — создадим новую
  if (existing.deletedAt) return null;
  return existing.id;
}
