// POST /api/admin/restore — restore DB from a logical JSON dump (§9.8 / R5.3).
// Bearer ADMIN_TOKEN or owner/admin cookie.
//
// Flow (v2.32.0 — два источника):
//   {backupId}             — локальный дамп из /tmp/backups (прежнее поведение)
//   {source:"github", tagName?} — durable-копия: ассет draft-релиза GitHub
//                            (tagName опционален → последний backup-релиз).
//                            Скачивание → sha256 → файл в /tmp/backups →
//                            BackupJob-строка → тот же restore-конвейер.
//
//   1) Auth (admin)
//   2) Получить контент дампа + провенанс (локальный файл или GitHub-ассет)
//   3) Recompute SHA256, compare to stored checksum (if recorded)
//   4) Parse JSON dump ({version,timestamp,Session[],GpsPoint[],...})
//   5) libsql transaction: TRUNCATE every table (FK-safe order) + INSERT all
//      rows from dump (forward FK order)
//   6) Audit log entry for restore action (written AFTER restore so it
//      survives the truncate)
//   7) Return { ok, restoredAt, backupId, tablesCount, checksumVerified }
//
// Notes:
//   - BigInt columns (GpsPoint.timestamp) are stored in dump as
//     "BIGINT:<digits>" strings — converted back to BigInt on insert.
//   - The current BackupJob row (id=backupId) is preserved across truncate
//     to avoid losing the restore provenance.
//   - Таблицы/порядки/вайлист колонок — src/lib/restore-core.ts (общие для
//     обоих источников, покрыты unit-тестами).
import { NextRequest } from "next/server";
import { z } from "zod";
import { db, batchChunked } from "@/lib/db";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { buildRestoreStatements, type BackupDump } from "@/lib/restore-core";
import { findGitHubBackupForRestore, downloadDecryptedBackupAsset, isGitHubBackupConfigured } from "@/lib/github-backup";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";

export const dynamic = "force-dynamic";

const BACKUP_STORAGE_DIR = "/tmp/backups";

const RestoreRequest = z.union([
  z.object({ backupId: z.string().min(1) }),
  z.object({ source: z.literal("github"), tagName: z.string().min(1).optional() }),
]);

interface RestoreSourceMeta {
  backupId: string;
  label: string;
  checksum: string | null;
  content: string;
  filePath: string;
}

/** Локальный путь: BackupJob из БД + файл из /tmp/backups (с path containment). */
async function loadLocalSource(backupId: string): Promise<RestoreSourceMeta | { error: ReturnType<typeof json> }> {
  const job = await db.backupJob.findUnique({ where: { id: backupId } });
  if (!job) return { error: json({ error: "Backup not found" }, 404) };
  const filePath = job.filePath == null ? "" : String(job.filePath);
  if (!filePath) {
    return { error: json({ error: "Backup has no filePath (not yet completed)" }, 400) };
  }
  // v2.42.2 (§B6): memory://-маркер — дамп существовал только в памяти инвокации
  // (edge-рантайм без fs). Восстановление — из durable-копии: {source:"github"}.
  if (filePath.startsWith("memory://")) {
    return { error: json({ error: "Backup exists only in memory (edge runtime, no filesystem) — restore it from GitHub durable copy: {source:'github'}", backupId }, 400) };
  }
  if (job.status !== "completed") {
    return { error: json({ error: `Backup status is '${job.status}', must be 'completed'` }, 400) };
  }
  // path containment — путь строго внутри /tmp/backups.
  // Скомпрометированная строка в БД не должна давать чтение произвольного файла.
  const resolvedPath = path.resolve(BACKUP_STORAGE_DIR, path.isAbsolute(filePath) ? path.basename(filePath) : filePath);
  if (!resolvedPath.startsWith(BACKUP_STORAGE_DIR + path.sep) && resolvedPath !== BACKUP_STORAGE_DIR) {
    return { error: json({ error: "Backup path escapes storage dir" }, 400) };
  }
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    logger.error("Restore: read file failed", { backupId, path: resolvedPath, error: err instanceof Error ? err.message : String(err) });
    return { error: json({ error: "Backup file not readable", path: resolvedPath }, 500) };
  }
  return { backupId, label: `local:${backupId}`, checksum: job.checksum == null ? null : String(job.checksum), content, filePath: resolvedPath };
}

/**
 * GitHub-путь: durable-копия. Скачивает ассет draft-релиза (v2.38.1/ревью F13:
 * ассеты с v2.38.1 шифруются AES-256-GCM — TELMENC1-магия распознаётся и
 * расшифровывается автоматически; старые plaintext-ассеты читаются как есть),
 * проверяет sha256 по checksum из тела релиза, кладёт файл в /tmp/backups и
 * создаёт BackupJob completed-строку (провенанс + видимость в listBackups).
 * Работает и после рестарта/деплоя инстанса — в отличие от локальных /tmp-файлов.
 */
async function loadGitHubSource(tagName: string | undefined): Promise<RestoreSourceMeta | { error: ReturnType<typeof json> }> {
  if (!isGitHubBackupConfigured()) {
    return { error: json({ error: "GitHub backup is not configured (GITHUB_TOKEN)" }, 400) };
  }
  let src;
  try {
    src = await findGitHubBackupForRestore(tagName);
  } catch (err) {
    logger.error("Restore: GitHub lookup failed", { tagName, error: err instanceof Error ? err.message : String(err) });
    return { error: json({ error: "GitHub release lookup failed" }, 502) };
  }
  if (!src) {
    return { error: json({ error: tagName ? `GitHub backup '${tagName}' not found` : "No GitHub backup releases found" }, 404) };
  }
  let content: string;
  try {
    // v2.38.1 (ревью F13): зашифрованные ассеты (.sql.enc, TELMENC1) расшифровываются
    // ключом GITHUB_BACKUP_ENCRYPTION_KEY; отсутствие ключа для зашифрованного ассета —
    // честная ошибка с понятным текстом (не тихая порча данных).
    content = await downloadDecryptedBackupAsset(src.assetUrl);
  } catch (err) {
    logger.error("Restore: GitHub asset download failed", { tagName: src.tagName, error: err instanceof Error ? err.message : String(err) });
    return { error: json({ error: err instanceof Error ? err.message : "GitHub asset download failed" }, 502) };
  }
  if (src.checksum) {
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== src.checksum) {
      return { error: json({ error: "Checksum mismatch — GitHub asset is corrupt", tagName: src.tagName, expected: src.checksum, actual }, 422) };
    }
  }
  // Файл в /tmp + BackupJob-строка: провенанс этого restore виден в UI/API.
  // v2.42.2 (§B6): на edge-рантайме (Cloudflare Workers) файловой записи нет —
  // контент уже в памяти, локальная копия ПРОПУСКАЕТСЯ (memory://-маркер),
  // BackupJob-провенанс сохраняется. Restore-конвейер ниже работает с content
  // независимо от наличия файла.
  let filePath: string;
  try {
    await fs.mkdir(BACKUP_STORAGE_DIR, { recursive: true });
    const safeTag = src.tagName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `restore-gh-${safeTag}-${Date.now()}.json`;
    filePath = path.join(BACKUP_STORAGE_DIR, fileName);
    await fs.writeFile(filePath, content, "utf8");
  } catch (fsErr) {
    const safeTag = src.tagName.replace(/[^a-zA-Z0-9._-]/g, "_");
    filePath = `memory://backups/restore-gh-${safeTag}-${Date.now()}.json`;
    logger.warn("Restore: локальная копия дампа не сохранена (edge-рантайм без fs) — restore идёт из памяти", {
      tagName: src.tagName,
      error: fsErr instanceof Error ? fsErr.message : String(fsErr),
    });
  }
  const job = await db.backupJob.create({
    data: {
      status: "completed",
      type: "github",
      filePath,
      fileSize: Buffer.byteLength(content),
      checksum: src.checksum || createHash("sha256").update(content).digest("hex"),
      completedAt: new Date(),
      lockedBy: "restore-from-github",
    },
  });
  return { backupId: String(job.id), label: `github:${src.tagName}`, checksum: src.checksum, content, filePath };
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => ({}));
    const parsed = RestoreRequest.safeParse(body);
    if (!parsed.success) {
      return json({ error: "backupId required (string) or {source:'github', tagName?}" }, 400, { "X-Request-Id": requestId });
    }

    const loaded = "backupId" in parsed.data
      ? await loadLocalSource(parsed.data.backupId)
      : await loadGitHubSource(parsed.data.tagName);
    if ("error" in loaded) return loaded.error;
    const { backupId, label, checksum, content, filePath } = loaded;

    // Validate SHA256 checksum if recorded
    let checksumVerified: boolean | null = null;
    if (checksum) {
      const actual = createHash("sha256").update(content).digest("hex");
      checksumVerified = actual === checksum;
      if (!checksumVerified) {
        await writeAudit({
          action: "backup.restore",
          targetId: backupId,
          targetType: "BackupJob",
          actorType: auth.via === "cookie" ? "user" : "system",
          actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"),
          metadata: { checksumVerified: false, expected: checksum, actual, source: label },
        });
        return json({ error: "Checksum mismatch — backup file is corrupt", backupId, expected: checksum, actual }, 422, { "X-Request-Id": requestId });
      }
    }

    // Parse dump JSON
    let dump: BackupDump;
    try {
      dump = JSON.parse(content) as BackupDump;
    } catch (err) {
      logger.warn("Restore: dump is not valid JSON", { requestId, backupId, error: err instanceof Error ? err.message : String(err) });
      return json({ error: "Backup file is not valid JSON" }, 422, { "X-Request-Id": requestId });
    }

    // Truncate + insert (v2.38.1, ревью F3): на D1 один batch с ~48,5K
    // стейтментов превышал лимит шлюза 500 → restore всегда падал (RTO
    // недостижим). Теперь: restore-core собирает МНОГОРЯДНЫЕ INSERT (~10×
    // меньше стейтментов), а batchChunked применяет их чанками ≤400 на D1
    // (DELETE-фаза ~13 стейтментов — атомарна одним чанком; INSERT — по чанкам;
    // сквозная атомарность между чанками на D1 недостижима — сбой midway
    // оставляет применённые чанки, ПОВТОРНЫЙ restore идемпотентен: конвейер
    // начинается с полного DELETE). На libsql/Turso — прежний одиночный
    // атомарный batch (hrana-HTTP: BEGIN/COMMIT отдельными execute() не
    // гарантируют транзакцию).
    const restoredAt = new Date().toISOString();
    let tablesCount: Record<string, number>;
    try {
      const { stmts, tablesCount: tc, unknownTables } = buildRestoreStatements(dump, backupId);
      tablesCount = tc;
      if (unknownTables.length > 0) {
        logger.warn("Restore: unknown top-level keys in dump (skipped)", { requestId, backupId, unknownTables });
      }
      await batchChunked(stmts);
    } catch (err) {
      logger.error("Restore: transaction failed, rolled back", { requestId, backupId, error: err instanceof Error ? err.message : String(err) });
      await writeAudit({
        action: "backup.restore",
        targetId: backupId,
        targetType: "BackupJob",
        actorType: auth.via === "cookie" ? "user" : "system",
        actorId: auth.via === "cookie" ? "owner" : "admin-token",
        metadata: { error: err instanceof Error ? err.message : String(err), checksumVerified, source: label },
      });
      return json({ error: "Restore transaction failed — rolled back, DB unchanged" }, 500, { "X-Request-Id": requestId });
    }

    // Audit log entry for successful restore (written AFTER commit, so it
    // survives in the restored DB and is associated with the restore action).
    await writeAudit({
      action: "backup.restore",
      targetId: backupId,
      targetType: "BackupJob",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "admin-token",
      metadata: { restoredAt, source: label, sourceFile: filePath, checksumVerified, tablesCount, dumpVersion: dump.version, dumpTimestamp: dump.timestamp },
    });

    const totalRows = Object.values(tablesCount).reduce((a, b) => a + b, 0);
    return json(
      { ok: true, restoredAt, backupId, source: label, filePath, checksumVerified, tablesCount, totalRows, dumpVersion: dump.version, dumpTimestamp: dump.timestamp },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Restore error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
