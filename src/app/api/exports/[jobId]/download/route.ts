// GET /api/exports/[jobId]/download — отдаёт файл экспорта
// v2.38.2 · F48: (а) сгенерированный артефакт КЭШИРУЕТСЯ in-memory
// (src/lib/agg-cache.ts, LRU с бюджетом байтов) — повторные скачивания не
// грузят все точки сессии и не пересобирают GPX/KML заново. Ключ кэша
// включает Session.pointCount → новые точки инжеста меняют ключ и артефакт
// пересобирается (самоинвалидация по данным). Колонки-блоба в ExportJob нет,
// а её добавление = миграция Prisma — выбран LRU-кэш в памяти инстанса
// (рестарт → первый download пересобирает, корректно);
// (б) job.error наружу НЕ отдаётся (это poll-роут): клиент — только общие
// тексты, детали — в журнал сервера.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionVisibleTo } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { generateExport } from "@/lib/export";
import { exportArtifactKey, getExportArtifact, setExportArtifact } from "@/lib/agg-cache"; // v2.38.2 · F48

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { jobId } = await params;
    // v2.38.2 · F48: лёгкий запрос — только поля джоба БЕЗ точек (раньше
    // include.session.gpsPoints выкачивал все строки GpsPoint на каждый
    // download; userId/deletedAt/pointCount сессии — отдельным точечным
    // SELECT, как в poll-роуте с v2.16.0 I2). Точки грузятся ТОЛЬКО при
    // промахе кэша артефакта.
    const job = await db.exportJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    if (job.status !== "completed") return json({ error: "Not ready" }, 202, { "X-Request-Id": requestId });
    // v2.9.4 fix: expiresAt — ISO-строка; new Date() парсит и строку, и легаси-число
    const expiresAt = job.expiresAt == null ? null : String(job.expiresAt); // v2.18.0: типизированный db
    if (expiresAt && new Date(expiresAt) < new Date()) return json({ error: "Expired" }, 410, { "X-Request-Id": requestId });
    // v2.18.0: софт-делетнутая сессия больше не отдаётся по экспорт-ссылке
    // (раньше файл скачивался весь TTL после удаления поездки пользователем)
    const ownRes = await libsql.execute({
      sql: "SELECT userId, deletedAt, pointCount FROM Session WHERE id = ? LIMIT 1",
      args: [String(job.sessionId)],
    });
    if (ownRes.rows.length === 0) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    const sessionMeta = ownRes.rows[0] as Record<string, unknown>;
    if (sessionMeta.deletedAt != null) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    // v2.23.0: изоляция данных — файл чужой сессии не отдаётся (404, как удалённая)
    if (!sessionVisibleTo(dataScopeFor(auth), sessionMeta.userId)) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const format = job.format as "gpx" | "kml" | "json";
    const pointCount = Number(sessionMeta.pointCount ?? 0);

    // v2.38.2 · F48: артефакт для этого (jobId, формат, состав точек) уже
    // собран — отдаём из кэша без загрузки точек и генерации
    const artifactKey = exportArtifactKey(jobId, format, pointCount);
    const cached = getExportArtifact(artifactKey);
    if (cached) {
      return new Response(cached.content, {
        status: 200,
        headers: {
          "Content-Type": cached.mime,
          "Content-Disposition": `attachment; filename="session-${job.sessionId}.${cached.ext}"`,
          "X-Request-Id": requestId,
          "X-Cache": "artifact",
        },
      });
    }

    // Промах (первое скачивание / новые точки / рестарт): грузим точки и
    // генерируем, результат — в кэш (write-through для следующих скачиваний)
    const session = await db.session.findUnique({
      where: { id: String(job.sessionId) },
      select: {
        id: true,
        deviceId: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        status: true,
        gpsPoints: { orderBy: { timestamp: "asc" }, select: { lat: true, lon: true, speed: true, altitude: true, accuracy: true, bearing: true, timestamp: true } },
      },
    });
    // гонка: сессию удалили между двумя запросами — 404, как прежде
    if (!session) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });

    const { content, mime, ext } = generateExport(session as never, format);
    setExportArtifact(artifactKey, { content, mime, ext, bytes: Buffer.byteLength(content) });

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="session-${job.sessionId}.${ext}"`,
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    logger.error("Export download error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
