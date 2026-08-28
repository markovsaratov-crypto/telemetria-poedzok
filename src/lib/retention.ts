// src/lib/retention.ts — soft-delete grace + hard-delete + архивация (§3.7)
import { db } from "./db";
import { env } from "./env";
import { writeAudit } from "./audit";

// Hard-delete сессий с purgedAt старше archive retention, или сразу если архивация отключена.
export async function runRetention(): Promise<{ purged: number; archived: number }> {
  const now = new Date();
  const retentionMs = env().RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - retentionMs);

  let purged = 0;
  let archived = 0;

  // 1. Сессии со startTime старше RETENTION_DAYS → soft-delete + архивация
  const candidates = await db.session.findMany({
    where: {
      startTime: { lt: cutoff },
      deletedAt: null,
    },
    select: { id: true, deviceId: true, pointCount: true },
    take: 100,
  });

  for (const c of candidates) {
    if (env().RETENTION_ARCHIVE_ENABLED === "true") {
      // Архивация: логируем (в реальной системе — экспорт в cold storage)
      await writeAudit({
        action: "session.archive",
        targetId: c.id,
        targetType: "Session",
        actorType: "retention-cron",
        metadata: { deviceId: c.deviceId, pointCount: c.pointCount },
      });
      archived += 1;
    }
    await db.session.update({
      where: { id: c.id },
      data: { deletedAt: now, status: "deleted" },
    });
    await writeAudit({
      action: "session.delete",
      targetId: c.id,
      targetType: "Session",
      actorType: "retention-cron",
      metadata: { reason: "retention", pointCount: c.pointCount },
    });
  }

  // 2. Hard-delete сессий с deletedAt старше GRACE_PERIOD_DAYS
  const graceMs = env().GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const graceCutoff = new Date(now.getTime() - graceMs);
  const toPurge = await db.session.findMany({
    where: {
      deletedAt: { lt: graceCutoff, not: null },
      purgedAt: null,
    },
    select: { id: true, deviceId: true, pointCount: true },
    take: 50,
  });

  for (const s of toPurge) {
    await db.gpsPoint.deleteMany({ where: { sessionId: s.id } });
    await db.session.update({
      where: { id: s.id },
      data: { purgedAt: now, status: "archived" },
    });
    await writeAudit({
      action: "session.purge",
      targetId: s.id,
      targetType: "Session",
      actorType: "retention-cron",
      metadata: { deviceId: s.deviceId, pointCount: s.pointCount, reason: "grace-period-expired" },
    });
    purged += 1;
  }

  // 3. Audit log retention
  // P1-10: AuditLog.createdAt хранится как ISO-строка — сравнение с Date-объектом
  // (число) в SQLite всегда ложно (числа сортируются раньше строк). Передаём ISO-строку.
  const auditCutoff = new Date(now.getTime() - env().AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff.toISOString() } } });

  return { purged, archived };
}
