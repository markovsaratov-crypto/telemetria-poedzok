// scripts/backup-remote.ts — запуск полного бэкапа САНДБОКСА/CI по production-коду:
// дамп через d1-gateway (HTTP) → AES-256-GCM → GitHub draft-релиз → read-back drill.
// Почему не на воркере: free-план CF (CPU/память) не тянет 35МБ-дамп — 1102.
// bun scripts/backup-remote.ts (секреты в окружении).
const required = ["D1_GATEWAY_URL", "D1_GATEWAY_SECRET", "GITHUB_TOKEN", "GITHUB_BACKUP_ENCRYPTION_KEY"] as const;
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Отсутствует ${k} — задайте в окружении`);
    process.exit(1);
  }
}
process.env.NODE_ENV = "production";
process.env.GITHUB_REPO = process.env.GITHUB_REPO || "markovsaratov-crypto/telemetria-poedzok";
process.env.WORKER_ID = process.env.WORKER_ID || "backup-remote-01";
process.env.BACKUP_STORAGE_DIR = "/tmp/backups";

const t0 = Date.now();
const { backupToGitHub } = await import("../src/lib/github-backup");
try {
  const r = await backupToGitHub(process.env.WORKER_ID);
  console.log("=== БЭКАП ГОТОВ ===");
  console.log(JSON.stringify({ backupId: r.backupId, releaseUrl: r.releaseUrl, assetSize: r.assetSize, checksum: r.checksum, fileSize: r.fileSize, tableCounts: r.tableCounts, drill: r.drill, elapsedSec: Math.round((Date.now() - t0) / 1000) }, null, 2));
} catch (err) {
  console.error("БЭКАП ПРОВАЛЕН:", err instanceof Error ? err.message : String(err));
  process.exit(2);
}
