// backup-runner.ts — выполнение BackupJob (§9.8).
//
// ВАЖНО: BackupJob создаётся через POST /api/admin/backup и выполняется СРАЗУ
// в API route (синхронно, без Worker). Этот модуль — заглушка для future cron,
// который мог бы выполнять периодические резервные копии из Worker.
//
// Сейчас: просто логируем "idle" — реальной логики нет.
// Future: когда backup переедет в Worker, здесь будет:
//   1. POST /api/worker/poll?type=backup (или отдельный endpoint)
//   2. Выполнение mysqldump/pg_dump/libsql replication
//   3. POST /api/worker/complete-backup с результатом

let lastRunAt = 0;

/**
 * Заглушка для future cron выполнения BackupJob.
 * Сейчас: backup runner idle — выполняется в API route /api/admin/backup.
 */
export async function runBackupIfNeeded(): Promise<void> {
  const now = Date.now();
  // Throttle: логируем "idle" не чаще раза в минуту
  if (now - lastRunAt < 60_000) return;
  lastRunAt = now;
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      msg: "backup runner idle — BackupJob выполняется синхронно в /api/admin/backup",
      component: "backup-runner",
    })
  );
}
