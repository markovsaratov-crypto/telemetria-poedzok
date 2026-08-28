// src/lib/idempotency.ts — проверка (deviceId, clientId), возврат существующего sessionId (§6.2)
import { db } from "./db";

export async function findExistingSession(deviceId: string, clientId: string) {
  const existing = await db.session.findUnique({
    where: {
      deviceId_clientId: { deviceId, clientId },
    },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!existing) return null;
  // Soft-deleted сессия занимает уникальную пару (deviceId, clientId):
  // помечаем старый clientId надгробием и освобождаем пару —
  // повторный пакет создаёт НОВУЮ сессию (§6.3), история сохраняется.
  if (existing.deletedAt) {
    await db.session.update({
      where: { id: existing.id },
      data: { clientId: `${clientId}#deleted#${String(existing.id).slice(0, 8)}` },
    });
    return null;
  }
  return existing.id;
}
