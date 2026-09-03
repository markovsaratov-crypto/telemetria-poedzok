// src/lib/retention.ts — soft-delete grace + hard-delete + архивация (§3.7)
import { db, libsql } from "./db";
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
        targetId: String(c.id), // v2.18.0: типизированный db
        targetType: "Session",
        actorType: "retention-cron",
        metadata: { deviceId: c.deviceId, pointCount: c.pointCount },
      });
      archived += 1;
    }
    await db.session.update({
      where: { id: String(c.id) },
      data: { deletedAt: now, status: "deleted" },
    });
    await writeAudit({
      action: "session.delete",
      targetId: String(c.id),
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
    // v2.16.0 (R10): purge — АТОМАРНЫЙ batch (libsql.batch = одна транзакция):
    // раньше точки и статус сессии удалялись двумя независимыми вызовами —
    // краш между ними оставлял «очищенную» сессию с pointCount > 0 и без точек.
    // v2.16.0 (D2): заодно удаляем дочерние TrafficJob/ExportJob (каскад из
    // схемы не срабатывал — сессия не DELETE-нулась, а помечалась).
    await libsql.batch([
      { sql: "DELETE FROM TrafficJob WHERE sessionId = ?", args: [String(s.id)] },
      { sql: "DELETE FROM ExportJob WHERE sessionId = ?", args: [String(s.id)] },
      { sql: "DELETE FROM GpsPoint WHERE sessionId = ?", args: [String(s.id)] },
      { sql: "UPDATE Session SET purgedAt = ?, status = 'archived' WHERE id = ?", args: [now.toISOString(), String(s.id)] },
    ], "write");
    await writeAudit({
      action: "session.purge",
      targetId: String(s.id),
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

  // 4. v2.16.0 (D1): IngestMessage — идемпотентность инжеста нужна лишь на
  // горизонт HTTP-ретраев (минуты); без очистки таблица растёт бесконечно
  // (~1 строка/сек в движении) и не входит в бэкап/рестор.
  try {
    await libsql.execute({
      sql: "DELETE FROM IngestMessage WHERE firstSeenAt < ?",
      args: [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()],
    });
  } catch {
    // таблица отсутствует на старых БД — не фатально
  }

  // 5. v2.16.0 (B11): протухший кэш геокода — ключи geocode:* старше 30 суток
  // (раньше жил в Setting вечно и целиком перезаливался в память settings-кэша).
  try {
    await libsql.execute({
      sql: "DELETE FROM Setting WHERE key LIKE 'geocode:%' AND updatedAt < ?",
      args: [new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()],
    });
  } catch {
    // не фатально
  }

  return { purged, archived };
}
