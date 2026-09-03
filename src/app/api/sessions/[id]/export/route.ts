// POST /api/sessions/[id]/export — экспорт GPX/KML/JSON (§4.11)
// Если точек > EXPORT_ASYNC_THRESHOLD — создаёт ExportJob, иначе синхронно возвращает data URL.
//
// v2.18.0: решение sync/async — по ФАКТИЧЕСКОМУ числу строк GpsPoint (COUNT),
// а не по денормализованному Session.pointCount: он расходится с реальностью
// после чисток (документировано в sessions/route.ts), и «очищенная» сессия
// со счётчиком 0 уходила в SYNC-путь, переливая все точки в base64 data-URL.
// Точки грузятся ТОЛЬКО для sync-пути: раньше include грузил их всегда, а
// async-ветка (202) выбрасывала (воркер перечитает сам).
import { NextRequest } from "next/server";
import { zExportBody } from "@/lib/validation";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { generateExport } from "@/lib/export";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = zExportBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }

    // Скаляры сессии — БЕЗ точек (грузим ниже только если путь sync)
    const session = await db.session.findUnique({
      where: { id },
      select: { id: true, deviceId: true, deletedAt: true },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }
    const deviceId = String(session.deviceId ?? "unknown");

    // Фактическое число строк GpsPoint (v2.18.0)
    const cntRes = await libsql.execute({
      sql: "SELECT COUNT(*) AS cnt FROM GpsPoint WHERE sessionId = ?",
      args: [id],
    });
    const pointCountActual = Number((cntRes.rows[0] as Record<string, unknown>).cnt);

    // Async для больших сессий
    if (pointCountActual > env().EXPORT_ASYNC_THRESHOLD) {
      const job = await db.exportJob.create({
        data: {
          sessionId: String(session.id),
          format: parsed.data.format,
          status: "pending",
        },
      });
      await writeAudit({
        action: "session.export",
        targetId: String(session.id),
        targetType: "Session",
        actorType: auth.via === "cookie" ? "user" : "system",
        actorId: auth.via === "cookie" ? "owner" : "api",
        sessionId: String(session.id),
        metadata: { format: parsed.data.format, async: true, jobId: String(job.id) },
      });
      return json({ jobId: String(job.id), status: "pending", async: true }, 202, { "X-Request-Id": requestId });
    }

    // Sync для маленьких: точки грузим только здесь
    const full = await db.session.findUnique({
      where: { id },
      include: { gpsPoints: { orderBy: { timestamp: "asc" } } },
    });
    if (!full) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }
    const { content, mime, ext } = generateExport(full as never, parsed.data.format);
    const dataUrl = `data:${mime};base64,${Buffer.from(content, "utf8").toString("base64")}`;
    inc("export_completed_total", "Exports completed", 1, parsed.data.format);
    await writeAudit({
      action: "session.export",
      targetId: String(session.id),
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: String(session.id),
      metadata: { format: parsed.data.format, async: false, sizeBytes: content.length },
    });

    return json(
      {
        url: dataUrl,
        filename: `session-${deviceId}-${Date.now()}.${ext}`,
        format: parsed.data.format,
        size: content.length,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Export error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
