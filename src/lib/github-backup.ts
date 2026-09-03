// src/lib/github-backup.ts — GitHub Releases backup.
import { logger } from "./logger";
import { writeAudit } from "./audit";

const GITHUB_API = "https://api.github.com";

// v2.18.0: минимальные типы ответов GitHub (было `as any` — битый ответ
// (нет upload_url) падал сырым TypeError вместо понятной ошибки).
interface GhRelease {
  id: number;
  upload_url: string;
  html_url: string;
}
interface GhAsset {
  url: string;
  size: number;
}

function getGitHubConfig() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPO || "markovsaratov-crypto/telemetria-poedzok";
  if (!token) return null;
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return null;
  return { token, owner, repo: repoName };
}

export async function backupToGitHub(actorId?: string) {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");

  const { runBackup } = await import("./backup");
  const { promises: fs } = await import("fs");
  const local = await runBackup(actorId);
  const content = await fs.readFile(local.filePath);

  const now = new Date();
  const tag = `backup-${now.toISOString().slice(0,10)}-${now.toISOString().slice(11,19).replace(/:/g,"")}`;

  // C-1 (security): дамп БД содержит пользователей/поездки — релиз создаётся
  // как DRAFT (приватный): ассеты видны и скачиваются только владельцу репо
  // с write-доступом. Публичные релизы для бэкапов запрещены.
  const releaseRes = await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: `DB Backup ${now.toISOString().slice(0,19)}`, body: `Checksum: ${local.checksum}`, draft: true, prerelease: false, make_latest: "false" }),
  });
  if (!releaseRes.ok) throw new Error(`GitHub release failed: ${releaseRes.status}`);
  const release = await releaseRes.json() as GhRelease;
  if (!release || typeof release.upload_url !== "string") {
    // v2.18.0: осиротевший draft удаляем — раньше битый ответ оставлял пустой
    // черновик в репо навсегда (теги ежедневные, orphan'ы копились молча)
    try { await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases/${release?.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${cfg.token}` } }); } catch {}
    throw new Error("GitHub release response is malformed (no upload_url)");
  }

  try {
    const uploadUrl = release.upload_url.replace(/\{.*\}/, "");
    const fileName = local.filePath.split("/").pop() || "backup.json";
    const uploadRes = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "Content-Length": String(content.length) },
      body: content,
    });
    if (!uploadRes.ok) throw new Error(`GitHub upload failed: ${uploadRes.status}`);
    const asset = await uploadRes.json() as GhAsset;

    await writeAudit({ action: "backup.github.upload", targetId: local.backupId, targetType: "BackupJob", actorType: actorId ? "user" : "backup-cron", actorId, metadata: { releaseId: release.id, draft: true, assetUrl: asset?.url ?? "", assetSize: asset?.size ?? 0, checksum: local.checksum } });

    return { backupId: local.backupId, releaseId: release.id, releaseUrl: release.html_url, assetUrl: asset?.url ?? "", assetSize: asset?.size ?? 0, checksum: local.checksum, draft: true as const };
  } catch (err) {
    // v2.18.0: сбой аплоада ассета больше НЕ оставляет осиротевший draft-релиз:
    // теги дневные, мусор накапливался невидимо. Best-effort удаление + лог.
    try {
      await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases/${release.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" },
      });
      logger.warn("github-backup: asset upload failed — orphan draft release deleted", { releaseId: release.id, tag });
    } catch (cleanupErr) {
      logger.error("github-backup: asset upload failed AND orphan cleanup failed (проверьте релизы вручную)", {
        releaseId: release.id,
        tag,
        cleanupError: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw err;
  }
}

interface GhReleaseList {
  tag_name: string;
  id: number;
  name: string | null;
  created_at: string;
  draft: boolean;
  html_url: string;
  body?: string;
  assets: Array<{ url: string; browser_download_url: string; size: number }>;
}

export async function listGitHubBackups() {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases?per_page=100`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status}`);
  const releases = await res.json() as GhReleaseList[];
  return releases.filter(r => r.tag_name.startsWith("backup-")).slice(0, 50).map(r => ({
    backupId: r.tag_name, releaseId: r.id, tagName: r.tag_name, name: r.name || r.tag_name, createdAt: r.created_at,
    // draft-релизы приватны: browser_download_url анонимно не работает —
    // отдаём API-URL ассета (владелец качает с токеном/через UI GitHub)
    assetUrl: r.draft ? (r.assets[0]?.url || "") : (r.assets[0]?.browser_download_url || ""),
    releaseUrl: r.html_url,
    isDraft: !!r.draft,
    assetSize: r.assets[0]?.size || 0, checksum: r.body?.match(/Checksum.*?:\s*([a-f0-9]{64})/i)?.[1],
  }));
}

export function isGitHubBackupConfigured(): boolean {
  return getGitHubConfig() !== null;
}
