// GET /api/exports/[jobId] — poll статуса экспорта (§4.12)
// GET /api/exports/[jobId]/download — скачать файл
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { jobId } = await params;
    // v2.16.0 (I2): poll-роут выбирает ТОЛЬКО поля джоба. Раньше тут был
    // `include: { session: { include: { gpsPoints } } }` — polling каждые 1,5 с
    // ПОЛНОСТЬЮ переливал все точки сессии (у 5k-точечного экспорта — 5k строк
    // на КАЖДЫЙ poll, пока воркер не завершит). Контент генерирует download-роут.
    const job = await db.exportJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });

    if (job.status !== "completed") {
      return json({ status: job.status, jobId }, 202, { "X-Request-Id": requestId });
    }

    // Если expired (v2.9.4 fix: expiresAt хранится ISO-строкой — сравнение строки с Date давало NaN;
    // new Date() корректно парсит и ISO-строку, и легаси-число)
    if (job.expiresAt && new Date(job.expiresAt) < new Date()) {
      return json({ error: "Export expired", jobId }, 410, { "X-Request-Id": requestId });
    }

    return json(
      {
        status: "completed",
        jobId,
        url: `/api/exports/${jobId}/download`,
        fileSize: job.fileSize,
        expiresAt: job.expiresAt,
        format: job.format,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Export poll error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
