// src/lib/github-backup.ts — GitHub Releases backup.
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { env } from "./env";
import { countDumpRows, type BackupDump } from "./restore-core";

const GITHUB_API = "https://api.github.com";

// минимальные типы ответов GitHub (было `as any` — битый ответ
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
    // осиротевший draft удаляем — битый ответ оставлял пустой
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

    // Read-back drill: сразу после аплоада скачиваем ассет обратно и
    // проверяем восстановимость durable-копии (sha256 + парсинг + счёт строк).
    // Дёшево (один запрос), закрывает «restore никогда не проверялся».
    const drill = await runBackupReadBackDrill({
      assetUrl: asset?.url ?? "",
      expectedChecksum: local.checksum,
      expectedCounts: local.tableCounts,
      tag,
      actorId,
    });

    return { backupId: local.backupId, releaseId: release.id, releaseUrl: release.html_url, assetUrl: asset?.url ?? "", assetSize: asset?.size ?? 0, checksum: local.checksum, draft: true as const, drill };
  } catch (err) {
    // сбой аплоада ассета больше НЕ оставляет осиротевший draft-релиз:
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
  assets: Array<{ url: string; browser_download_url: string; size: number; name?: string }>;
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

// ——— v2.32.0: restore-from-GitHub + read-back drill ———

export interface GitHubRestoreSource {
  tagName: string;
  releaseId: number;
  assetUrl: string;
  checksum: string | null;
  createdAt: string;
}

/**
 * Находит durable-копию для restore: по тегу (точный backup-…) или последнюю.
 * Выбирает только релизы с ровно одним ассетом — как создаёт backupToGitHub.
 */
export async function findGitHubBackupForRestore(tagName?: string): Promise<GitHubRestoreSource | null> {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(`${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/releases?per_page=100`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status}`);
  const releases = (await res.json() as GhReleaseList[]).filter(r => r.tag_name.startsWith("backup-") && r.assets.length > 0);
  const found = tagName ? releases.find(r => r.tag_name === tagName) : releases[0];
  if (!found) return null;
  return {
    tagName: found.tag_name,
    releaseId: found.id,
    assetUrl: found.assets[0].url,
    checksum: found.body?.match(/Checksum.*?:\s*([a-f0-9]{64})/i)?.[1] ?? null,
    createdAt: found.created_at,
  };
}

/**
 * Скачивает дамп-ассет draft-релиза через GitHub API (Accept: octet-stream —
 * единственный способ для приватных draft-ассетов). Возвращает текст дампа.
 */
export async function downloadGitHubBackupAsset(assetUrl: string): Promise<string> {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(assetUrl, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`GitHub asset download failed: ${res.status}`);
  return await res.text();
}

export interface DrillResult {
  ok: boolean;
  checksumVerified: boolean;
  parsed: boolean;
  totalRows: number;
  countsMatch: boolean;
  detail?: string;
}

/**
 * Read-back drill: durable-копия должна быть ВОССТАНОВИМОЙ, а не просто
 * существующей. Скачивает ассет обратно, сверяет sha256 с чексуммой аплоада,
 * парсит JSON и сверяет счётчики строк с дампом-источником. Результат —
 * в аудит + лог (+ Slack при провале). Не бросает исключений.
 */
export async function runBackupReadBackDrill(opts: {
  assetUrl: string;
  expectedChecksum: string;
  expectedCounts?: Record<string, number>;
  tag: string;
  actorId?: string;
}): Promise<DrillResult> {
  const result: DrillResult = { ok: false, checksumVerified: false, parsed: false, totalRows: 0, countsMatch: false };
  try {
    if (!opts.assetUrl) throw new Error("asset url is empty");
    const text = await downloadGitHubBackupAsset(opts.assetUrl);
    const { createHash } = await import("crypto");
    const actual = createHash("sha256").update(text).digest("hex");
    result.checksumVerified = actual === opts.expectedChecksum;
    if (!result.checksumVerified) throw new Error(`drill checksum mismatch: expected ${opts.expectedChecksum.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);

    const dump = JSON.parse(text) as BackupDump;
    result.parsed = true;
    const counts = countDumpRows(dump);
    result.totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    if (opts.expectedCounts) {
      // сравниваем только таблицы дампа (User — информационный блок, в restore не входит)
      const mismatches = Object.entries(opts.expectedCounts).filter(([t, n]) => t in counts && (counts[t] ?? 0) !== n).map(([t, n]) => `${t}: dump ${n} → asset ${counts[t] ?? 0}`);
      result.countsMatch = mismatches.length === 0;
      if (!result.countsMatch) throw new Error(`drill row-count mismatch: ${mismatches.join("; ")}`);
    }
    result.ok = true;
    logger.info("github-backup: read-back drill OK", { tag: opts.tag, totalRows: result.totalRows });
  } catch (err) {
    result.detail = err instanceof Error ? err.message : String(err);
    logger.error("github-backup: read-back drill FAILED — durable-копия не проверена как восстановимая", { tag: opts.tag, detail: result.detail });
    // Slack при провале дрilli — это единственный автоматический сигнал
    // «бэкап может не восстановиться». Доставка best-effort.
    try {
      const { sendSlackMessage } = await import("./alerts");
      await sendSlackMessage(`🧪 «Телеметрия поездок»: read-back drill провален (${opts.tag}) — ${result.detail ?? "unknown"}. Durable-копия НЕ проверена как восстановимая — проверьте релиз вручную.`);
    } catch { /* алерт не должен маскировать исходную ошибку */ }
  }
  // drill-статус — в аудит всегда (и успех, и провал): видно из /api/admin/jobs и BackupJob-истории
  try {
    await writeAudit({
      action: "backup.drill",
      targetId: opts.tag,
      targetType: "GitHubRelease",
      actorType: opts.actorId ? "user" : "backup-cron",
      actorId: opts.actorId,
      metadata: { ...result },
    });
  } catch { /* аудит не должен маскировать исходную ошибку */ }
  return result;
}
