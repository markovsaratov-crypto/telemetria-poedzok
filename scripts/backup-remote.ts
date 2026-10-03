// scripts/backup-remote.ts — запуск полного бэкапа САНДБОКСА/CI по production-коду:
// дамп через d1-gateway (HTTP) → AES-256-GCM → GitHub draft-релиз → read-back drill.
// Почему не на воркере: free-план CF (CPU/память) не тянет 35МБ-дамп — 1102.
// bun scripts/backup-remote.ts (секреты в окружении).
export {}; // файл — ES-модуль (top-level await)
const required = ["D1_GATEWAY_URL", "D1_GATEWAY_SECRET", "GITHUB_TOKEN", "GITHUB_BACKUP_ENCRYPTION_KEY"] as const;
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Отсутствует ${k} — задайте в окружении`);
    process.exit(1);
  }
}
(process.env as { NODE_ENV?: string }).NODE_ENV = "production"; // readonly в типах Next — каст
process.env.GITHUB_REPO = process.env.GITHUB_REPO || "markovsaratov-crypto/telemetria-poedzok";
process.env.WORKER_ID = process.env.WORKER_ID || "backup-remote-01";
process.env.BACKUP_STORAGE_DIR = "/tmp/backups";

const t0 = Date.now();
const { backupToGitHub } = await import("../src/lib/github-backup");
try {
  const r = await backupToGitHub(process.env.WORKER_ID);
  console.log("=== БЭКАП ГОТОВ ===");
  console.log(JSON.stringify({ backupId: r.backupId, releaseUrl: r.releaseUrl, assetSize: r.assetSize, checksum: r.checksum, fileSize: r.fileSize, tableCounts: r.tableCounts, drill: r.drill, elapsedSec: Math.round((Date.now() - t0) / 1000) }, null, 2));
  // v3.3 (CR-J, ревью F-06): drill-провал — НЕ «зелёный» прогон. Прежний код
  // глотал drill.ok=false (github-backup возвращает результат, не бросает) —
  // workflow уходил в success при НЕВОССТАНОВИМОЙ durable-копии (обнаружилось
  // бы только при живом restore). Exit 3 = отдельный код для «дамп есть, drill
  // провален»: GitHub шлёт уведомление о провале scheduled-ранов, ночные
  // алерты читаются людьми.
  if (r.drill && r.drill.ok !== true) {
    console.error("READ-BACK DRILL ПРОВАЛЕН: durable-копия НЕ проверена как восстановимая:", JSON.stringify(r.drill));
    process.exit(3);
  }
} catch (err) {
  console.error("БЭКАП ПРОВАЛЕН:", err instanceof Error ? err.message : String(err));
  process.exit(2);
}
