// src/lib/audit.ts — журнал аудита destructive-операций (§6.8)
import { db } from "./db";
import { inc } from "./metrics";

export interface AuditInput {
  action: string; // session.delete | session.purge | session.export | route.delete | backup.create | backup.restore
  targetId: string;
  targetType: string; // Session | Route | BackupJob
  actorType: string; // user | system | retention-cron | worker | backup-cron
  actorId?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      action: input.action,
      targetId: input.targetId,
      targetType: input.targetType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      sessionId: input.sessionId ?? null,
    },
  });
  inc("audit_log_total", "Audit log entries");
}
