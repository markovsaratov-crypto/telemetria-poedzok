// src/lib/github-backup.ts — GitHub Releases backup.
// v2.38.1 (ревью F13): ассеты шифруются AES-256-GCM ДО аплоада (формат
// TELMENC1 | IV(12) | GCM-tag(16) | ciphertext), ключ — опциональный env
// GITHUB_BACKUP_ENCRYPTION_KEY (32 байта hex). FAIL-CLOSED: ключ не задан —
// plaintext-дамп НЕ выгружается в GitHub вовсе (локальный дамп остаётся).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
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

export interface LocalBackupHandle {
  backupId: string;
  filePath: string;
  checksum: string;
  fileSize: number;
  tableCounts: Record<string, number>;
}

// ——— v2.38.1 (ревью F13): шифрование durable-копий AES-256-GCM ———
// Магия формата (8 байт): отличает зашифрованные ассеты от старых plaintext-дампов
// (restore/drill читают ОБА формата — обратная совместимость с релизами до v2.38.1).
const ENC_MAGIC = Buffer.from("TELMENC1", "utf8");

/**
 * Ключ шифрования бэкапов: GITHUB_BACKUP_ENCRYPTION_KEY, 32 байта в hex (64
 * символа). Конвенция env.ts для опциональных переменных: читается напрямую из
 * process.env (как GITHUB_TOKEN выше), валидируется В МОМЕНТ ИСПОЛЬЗОВАНИЯ.
 * Возвращает null, если ключ не задан (вызывающий решает политику: upload —
 * fail-closed, restore зашифрованного ассета — честная ошибка).
 */
function getBackupEncryptionKey(): Buffer | null {
  const raw = process.env.GITHUB_BACKUP_ENCRYPTION_KEY || "";
  if (raw === "") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "GITHUB_BACKUP_ENCRYPTION_KEY невалиден: ожидается 64 hex-символа (32 байта); сгенерируйте: openssl rand -hex 32"
    );
  }
  return Buffer.from(raw, "hex");
}

/** Шифрует дамп: TELMENC1 | IV(12) | GCM-tag(16) | ciphertext. */
export function encryptBackupAsset(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ENC_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Расшифровывает ассет бэкапа. Ассет БЕЗ магии TELMENC1 — старый plaintext-дамп
 * (до v2.38.1) — возвращается как есть. GCM-тег гарантирует целостность:
 * подмена/порча зашифрованного ассета → исключение с понятным текстом.
 */
export function decryptBackupAsset(raw: Buffer): string {
  if (!raw.subarray(0, 8).equals(ENC_MAGIC)) return raw.toString("utf8");
  if (raw.length < 8 + 12 + 16) {
    throw new Error("зашифрованный бэкап повреждён: короче заголовка TELMENC1 (IV+tag)");
  }
  const key = getBackupEncryptionKey();
  if (!key) {
    throw new Error(
      "ассет бэкапа зашифрован (TELMENC1), но GITHUB_BACKUP_ENCRYPTION_KEY не задан — задайте 32-байтный hex-ключ, которым шифровались бэкапы (см. docs/OPERATIONS.md)"
    );
  }
  const iv = raw.subarray(8, 20);
  const tag = raw.subarray(20, 36);
  const ciphertext = raw.subarray(36);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // GCM-тег не сошёлся: неверный ключ ИЛИ ассет бит/подменён — тексты Node
    // («Unsupported state or unable to authenticate data») не говорят этого
    throw new Error(
      `не удалось расшифровать ассет бэкапа (GCM-тег не сошёлся): неверный GITHUB_BACKUP_ENCRYPTION_KEY или повреждённый ассет (${err instanceof Error ? err.message : String(err)})`
    );
  }
  return plaintext.toString("utf8");
}

export async function backupToGitHub(actorId?: string, existing?: LocalBackupHandle) {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");

  const { runBackup } = await import("./backup");
  const { promises: fs } = await import("fs");
  // v2.32.0: existing — уже сделанный локальный дамп (ежедневный backup-крон
  // делает дамп и аплоадит ЕГО, без второго полного дампа).
  const local = existing ?? (await runBackup(actorId));
  const content = await fs.readFile(local.filePath);

  // v2.38.1 (ревью F13) FAIL-CLOSED: дамп содержит PII (треки, deviceId, email)
  // и настройки — plaintext больше НЕ выгружается в GitHub Releases даже
  // draft-релизом: публикация draft — одна кнопка в UI GitHub (ровно так
  // случился инцидент C-1). Без ключа шифрования аплоад ПРОПУСКАЕТСЯ (локальный
  // дамп остаётся, durable-уровень деградирует до «нет копии» — это видно и в
  // логе, и в ответе роута), сигнал — logger.error + Slack.
  const encKey = getBackupEncryptionKey();
  if (!encKey) {
    const msg =
      "GITHUB_BACKUP_ENCRYPTION_KEY не задан — отказ выгружать plaintext-дамп в GitHub (fail-closed, ревью F13); сгенерируйте и задайте: openssl rand -hex 32";
    logger.error("github-backup: дамп НЕ выгружен в GitHub (нет ключа шифрования)", {
      backupId: local.backupId,
    });
    try {
      const { sendSlackMessage } = await import("./alerts");
      await sendSlackMessage(
        `🔒 «Телеметрия поездок»: durable-копия в GitHub НЕ создана — не задан GITHUB_BACKUP_ENCRYPTION_KEY (plaintext не выгружается, ревью F13). Локальный дамп создан.`
      );
    } catch { /* алерт не должен маскировать исходную ошибку */ }
    throw new Error(msg);
  }
  // Шифруем ДО любого сетевого взаимодействия: в память GitHub уходит только ciphertext
  const uploadBody = encryptBackupAsset(content, encKey);

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
    // v2.38.1 (ревью F13): имя ассета .sql.enc — зашифрованный бинарник
    // (plaintext-дамп в релизах больше не появляется).
    const baseName = local.filePath.split("/").pop() || "backup.json";
    const fileName = `${baseName.replace(/\.json$/, "")}.sql.enc`;
    const uploadRes = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream", "Content-Length": String(uploadBody.length) },
      // Uint8Array-обёртка: DOM-тайпинги fetch не принимают Buffer как BodyInit
      body: new Uint8Array(uploadBody),
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

    return { backupId: local.backupId, releaseId: release.id, releaseUrl: release.html_url, assetUrl: asset?.url ?? "", assetSize: asset?.size ?? 0, checksum: local.checksum, fileSize: local.fileSize, tableCounts: local.tableCounts, draft: true as const, drill };
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
 * единственный способ для приватных draft-ассетов). Возвращает СЫРЫЕ байты:
 * с v2.38.1 ассеты зашифрованы (TELMENC1), расшифровка — decryptBackupAsset.
 */
export async function downloadGitHubBackupAsset(assetUrl: string): Promise<Buffer> {
  const cfg = getGitHubConfig();
  if (!cfg) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(assetUrl, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`GitHub asset download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Скачивает и расшифровывает дамп-ассет: TELMENC1-ассеты — AES-256-GCM c тем же
 * ключом, старые plaintext-ассеты (до v2.38.1) — как есть. Возвращает текст дампа.
 * v2.38.1 (ревью F13): путь restore-from-GitHub и read-back drill.
 */
export async function downloadDecryptedBackupAsset(assetUrl: string): Promise<string> {
  const raw = await downloadGitHubBackupAsset(assetUrl);
  return decryptBackupAsset(raw);
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
    // v2.38.1 (ревью F13): drill скачивает СЫРЫЕ байты и расшифровывает их же
    // кодом, что и restore (TELMENC1) — проверяется именно восстановимость
    // durable-копии, включая расшифровку; sha256 — по PLAINTEXT (чексумма
    // локального дампа-источника), как и до v2.38.1.
    const text = await downloadDecryptedBackupAsset(opts.assetUrl);
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
