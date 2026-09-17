// src/lib/backup.ts — логический дамп БД (BackupJob), верификация checksum (§9.8)
import { db, libsql, D1_PARAM_BUDGET } from "./db";
import { env } from "./env";
import { writeAudit } from "./audit";
import { logger } from "./logger"; // v2.18.0: изоляция сбоя статуса BackupJob
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";

// P0-фикс v2.9.10 (Render build failure): Turbopack static analysis помечает
// fs-операции с динамическим путём из env() как "dynamic filesystem access" →
// трассировка всего проекта → build failed на Render. Решение: использовать
// ЧИСТЫЙ СТРОКОВЫЙ ЛИТЕРАЛ "/tmp/backups" (то же значение что и env var
// BACKUP_STORAGE_DIR в render.yaml). Turbopack видит константу — никакой
// динамической трассировки. Env-переопределение BACKUP_STORAGE_DIR намеренно
// не используется (поведение на проде идентично env var значению).
const BACKUP_STORAGE_DIR = "/tmp/backups";

// v2.38.1 (ревью F13): секретные ключи Setting маскируются в дампе — значение
// не должно покидать сервер даже в (шифрованных) GitHub-копиях. Restore
// восстановит маску: реальное значение задаётся заново после restore (env/адмнка).
const SETTING_SECRET_KEYS = new Set(["TWO_GIS_API_KEY"]);
const SETTING_MASKED_VALUE = "[REDACTED-BY-BACKUP]";

/**
 * v2.38.1 (ревью F25): дочерние строки таблицы с FK sessionId — ТОЛЬКО по
 * срезу уже задампленных сессий, чанками ≤90 id (лимит связанных параметров
 * D1 ≤100; константа D1_PARAM_BUDGET — единый источник в db.ts). Сироты
 * (сессия создана инжестом ПОСЛЕ дампа Session) в дамп не попадают → restore
 * не падает по FK. includeNullSessionId — строки без сессии (TrafficJob
 * поездок v2.26, системный аудит): FK-сиротами быть не могут, дампятся целиком.
 */
async function dumpChildRows(table: string, sessionIds: string[], includeNullSessionId: boolean): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < sessionIds.length; i += D1_PARAM_BUDGET) {
    const chunk = sessionIds.slice(i, i + D1_PARAM_BUDGET);
    const ph = chunk.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT * FROM ${table} WHERE sessionId IN (${ph})`,
      args: chunk as never[],
    });
    out.push(...res.rows);
  }
  if (includeNullSessionId) {
    const res = await libsql.execute(`SELECT * FROM ${table} WHERE sessionId IS NULL`);
    out.push(...res.rows);
  }
  return out;
}

export async function runBackup(actorId?: string): Promise<{ backupId: string; filePath: string; checksum: string; fileSize: number; tableCounts: Record<string, number> }> {
  // Создаём BackupJob
  const job = await db.backupJob.create({
    data: { status: "running", type: "full", lockedBy: env().WORKER_ID },
  });

  try {
    // ——— v2.38.1 (ревью F25): СНАПШОТ-КОНСИСТЕНТНЫЙ дамп ———
    // Прежний цикл «SELECT * по всем таблицам подряд» без READ-транзакции (на
    // D1 их нет) гонялся с инжестом 24/7: сессия, созданная ПОСЛЕ дампа Session,
    // но ДО дампа GpsPoint, давала точки-сироты → restore INSERT нарушал FK и
    // весь «атомарный» restore откатывался — дамп, «одобренный» drill'ом
    // (счётчики совпали), был невосстановим. Теперь:
    //   1) Session дампится ПЕРВОЙ — фиксируется срез sessionId;
    //   2) FK-дети (GpsPoint/AuditLog/TrafficJob/ExportJob) — ТОЛЬКО по срезу;
    //   3) пост-чек Σ pointCount == задампленные точки тех же сессий —
    //      расхождение = гонка с инжестом/retention → бэкап failed (retry);
    //   4) watermark среза — в метаданных дампа (старый restore игнорирует).
    // Полные выгрузки остальных таблиц сохранены (P0-фикс v2.9.1: db-обёртки
    // имеют тихие лимиты — прямой SQL гарантирует полноту; v2.29.0: + Trip,
    // + IngestMessage (ledger идемпотентности), + _AlertState (алерты)).
    const snapshotStartedAt = new Date().toISOString();

    // 1) Session — фиксирует срез снапшота.
    // purge (retention) удаляет ТОЧКИ сессии, но НЕ обнуляет pointCount —
    // сверка ведётся только по не-archived сессиям (purgedAt IS NULL).
    const sessionRes = await libsql.execute("SELECT * FROM Session");
    const sessionIds: string[] = [];
    const liveSessionIds = new Set<string>();
    let sumPointCount = 0;
    for (const r of sessionRes.rows as Record<string, unknown>[]) {
      const id = String(r.id);
      sessionIds.push(id);
      if (r.purgedAt == null) {
        liveSessionIds.add(id);
        sumPointCount += Number(r.pointCount ?? 0);
      }
    }

    // 2) GpsPoint — по срезу (сироты физически не попадают в дамп).
    const gpsRows = (await dumpChildRows("GpsPoint", sessionIds, false)) as Record<string, unknown>[];

    // 3) Пост-чек снапшота: каждая точка дампится ровно с одной не-archived
    // сессией и наоборот. Расхождение = между SELECT'ами вписались новые точки
    // (или retention удалил существующие) — дамп НЕ снапшот: помечаем failed
    // через существующий путь (catch ниже), оператор повторяет запуск.
    let livePoints = 0;
    for (const p of gpsRows) {
      if (liveSessionIds.has(String(p.sessionId))) livePoints++;
    }
    if (sumPointCount !== livePoints) {
      throw new Error(
        `Backup consistency check failed: Σ pointCount активных сессий (${sumPointCount}) != точек в дампе (${livePoints}) — дамп не является снапшотом (гонка с инжестом/retention), повторите бэкап`
      );
    }

    const rows: Record<string, unknown[]> = {
      Session: sessionRes.rows as unknown[],
      GpsPoint: gpsRows,
    };
    const tableCounts: Record<string, number> = {
      Session: sessionIds.length,
      GpsPoint: gpsRows.length,
    };

    // Таблицы без FK-зависимости от инжеста — полные выгрузки.
    for (const table of ["Trip", "IngestMessage", "Route", "RouteCache", "BackupJob", "_AlertState"] as const) {
      const res = await libsql.execute(`SELECT * FROM ${table}`);
      rows[table] = res.rows as unknown[];
      tableCounts[table] = res.rows.length;
    }

    // FK-дети Session — по срезу (см. dumpChildRows).
    rows.TrafficJob = await dumpChildRows("TrafficJob", sessionIds, true);
    rows.AuditLog = await dumpChildRows("AuditLog", sessionIds, true);
    rows.ExportJob = await dumpChildRows("ExportJob", sessionIds, false);
    tableCounts.TrafficJob = rows.TrafficJob.length;
    tableCounts.AuditLog = rows.AuditLog.length;
    tableCounts.ExportJob = rows.ExportJob.length;

    // Setting: без сырых дампов нераспознанных батчей (АУДИТ C-32) и БЕЗ
    // секретных значений (ревью F13 — маскировка denylist-ключей).
    {
      const res = await libsql.execute(`SELECT * FROM Setting WHERE key != 'diag.ingest.raw'`);
      rows.Setting = (res.rows as Record<string, unknown>[]).map((row) =>
        SETTING_SECRET_KEYS.has(String(row.key)) ? { ...row, value: SETTING_MASKED_VALUE } : row
      );
      tableCounts.Setting = rows.Setting.length;
    }

    // 4) Watermark среза — верхние границы задампленных данных (сверка при
    // разборе/переносе; restore-core ключ игнорирует, старые restore тоже).
    // timestamp приходит BigInt на libsql и Number на D1 (JSON-транспорт шлюза
    // конвертирует BigInt→Number; значения ~1.8e12 < 2^53 — точность полная).
    let maxGpsTimestamp: bigint | null = null;
    for (const p of gpsRows) {
      const t = p.timestamp;
      const tBig = typeof t === "bigint" ? t : typeof t === "number" && Number.isFinite(t) ? BigInt(t) : null;
      if (tBig !== null && (maxGpsTimestamp === null || tBig > maxGpsTimestamp)) {
        maxGpsTimestamp = tBig;
      }
    }
    let maxSessionUpdatedAt: string | null = null;
    for (const s of sessionRes.rows as Record<string, unknown>[]) {
      const u = s.updatedAt == null ? null : String(s.updatedAt);
      if (u != null && (maxSessionUpdatedAt === null || u > maxSessionUpdatedAt)) maxSessionUpdatedAt = u;
    }

    const dump = {
      version: env().APP_VERSION,
      timestamp: new Date().toISOString(),
      watermark: {
        capturedAt: snapshotStartedAt,
        sessions: sessionIds.length,
        points: gpsRows.length,
        maxGpsPointTimestamp: maxGpsTimestamp, // BigInt — сериализуется BIGINT:-ревайтером ниже
        maxSessionUpdatedAt,
      },
      ...rows,
      // User: без секретов (passwordHash) — только идентификационные поля.
      // v2.18.0 (документация): пользователи в дампе — ИНФОРМАЦИОННЫЕ (для
      // restore они не восстанавливаются: TABLES/ALLOWED_COLUMNS в restore-роуте
      // сознательно не содержат User — восстановление паролей без passwordHash
      // создало бы мёртвые аккаунты; ownerId в сессиях остаются валидными id).
      users: (await libsql.execute("SELECT id, email, role, createdAt, updatedAt FROM User")).rows,
    };
    tableCounts.User = dump.users.length;

    // BigInt-safe serialization: GpsPoint.timestamp is BigInt, JSON.stringify падает
    // Заменяем BigInt на строковое представление
    const content = JSON.stringify(dump, (key, value) =>
      typeof value === "bigint" ? `BIGINT:${value.toString()}` : value
    , 2);
    const checksum = createHash("sha256").update(content).digest("hex");
    const fileSize = Buffer.byteLength(content);

    // Сохраняем в файл (статический путь — Turbopack-friendly, см. коммент в начале файла)
    await fs.mkdir(BACKUP_STORAGE_DIR, { recursive: true });
    const fileName = `backup-${Date.now()}-${job.id}.json`;
    const filePath = path.join(BACKUP_STORAGE_DIR, fileName);
    await fs.writeFile(filePath, content, "utf8");

    // Верификация: перечитываем и сравниваем checksum
    let verified = false;
    if (env().BACKUP_VERIFICATION_ENABLED === "true") {
      const reread = await fs.readFile(filePath, "utf8");
      const recheck = createHash("sha256").update(reread).digest("hex");
      verified = recheck === checksum;
      if (!verified) {
        throw new Error("Backup verification failed: checksum mismatch");
      }
    }

    await db.backupJob.update({
      where: { id: String(job.id) },
      data: {
        status: "completed",
        filePath,
        fileSize,
        checksum,
        completedAt: new Date(),
      },
    });

    await writeAudit({
      action: "backup.create",
      targetId: String(job.id),
      targetType: "BackupJob",
      actorType: actorId ? "user" : "backup-cron",
      actorId,
      metadata: { filePath, fileSize, checksum, verified, tableCounts },
    });

    return { backupId: String(job.id), filePath, checksum, fileSize, tableCounts };
  } catch (err) {
    // v2.18.0: изоляция записи статуса — если упала сама БД (частая причина
    // сбоя бэкапа), этот UPDATE падал вторым и ЗАМЕНЯЛ исходную ошибку в стеке,
    // а BackupJob оставался «running» навсегда — что ещё и ломало алерт-правило
    // backup_failure (3 последние статусы: вечный running подавал «3×failed»).
    // Аудит-запись о провале — best-effort (не роняем исходную ошибку).
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await db.backupJob.update({
        where: { id: String(job.id) },
        data: {
          status: "failed",
          error: msg,
          completedAt: new Date(),
        },
      });
    } catch (markErr) {
      logger.error("backup: не удалось пометить BackupJob как failed (исходная ошибка сохранена)", {
        jobId: String(job.id),
        markError: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    try {
      await writeAudit({
        action: "backup.failed",
        targetId: String(job.id),
        targetType: "BackupJob",
        actorType: actorId ? "user" : "backup-cron",
        actorId,
        metadata: { error: msg.slice(0, 500) },
      });
    } catch {
      // аудит провала не должен затирать исходную ошибку
    }
    throw err;
  }
}

export async function listBackups() {
  return db.backupJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}
