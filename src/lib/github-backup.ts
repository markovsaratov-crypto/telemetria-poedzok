// src/lib/github-backup.ts — GitHub Releases backup.
import { logger } from "./logger";
import { writeAudit } from "./audit";

const GITHUB_API = "https://api.github.com";

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
  
  const releaseRes = await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: `DB Backup ${now.toISOString().slice(0,19)}`, body: `Checksum: ${local.checksum}`, draft: false, prerelease: false, make_latest: "false" }),
  });
  if (!releaseRes.ok) throw new Error(`GitHub release failed: ${releaseRes.status}`);
  const release = await releaseRes.json() as any;
  
  const uploadUrl = release.upload_url.replace(/\{.*\}/, "");
  const fileName = local.filePath.split("/").pop();
  const uploadRes = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "Content-Length": String(content.length) },
    body: content,
  });
  if (!uploadRes.ok) throw new Error(`GitHub upload failed: ${uploadRes.status}`);
  const asset = await uploadRes.json() as any;
  
  await writeAudit({ action: "backup.github.upload", targetId: local.backupId, targetType: "BackupJob", actorType: actorId ? "user" : "backup-cron", actorId, metadata: { releaseId: release.id, assetUrl: asset.browser_download_url, assetSize: asset.size, checksum: local.checksum } as any });
  
  return { backupId: local.backupId, releaseId: release.id, releaseUrl: release.html_url, assetUrl: asset.browser_download_url, assetSize: asset.size, checksum: local.checksum };
}

export async function listGitHubBackups() {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases?per_page=100`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status}`);
  const releases = await res.json() as any[];
  return releases.filter(r => r.tag_name.startsWith("backup-")).slice(0, 50).map(r => ({
    backupId: r.tag_name, releaseId: r.id, tagName: r.tag_name, name: r.name || r.tag_name, createdAt: r.created_at, assetUrl: r.assets[0]?.browser_download_url || "", assetSize: r.assets[0]?.size || 0, checksum: r.body?.match(/Checksum.*?:\s*([a-f0-9]{64})/i)?.[1],
  }));
}

export function isGitHubBackupConfigured(): boolean {
  return getGitHubConfig() !== null;
}
