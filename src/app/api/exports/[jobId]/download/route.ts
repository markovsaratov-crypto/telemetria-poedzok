// GET /api/exports/[jobId]/download — отдаёт файл экспорта
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { generateExport } from "@/lib/export";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { jobId } = await params;
    const job = await db.exportJob.findUnique({
      where: { id: jobId },
      include: { session: { include: { gpsPoints: { orderBy: { timestamp: "asc" } } } } },
    });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    if (job.status !== "completed") return json({ error: "Not ready" }, 202, { "X-Request-Id": requestId });
    // v2.9.4 fix: expiresAt — ISO-строка; new Date() парсит и строку, и легаси-число
    if (job.expiresAt && new Date(job.expiresAt) < new Date()) return json({ error: "Expired" }, 410, { "X-Request-Id": requestId });

    // Генерируем контент на лету (в sandbox нет файлового хранилища)
    const { content, mime, ext } = generateExport(job.session as never, job.format as "gpx" | "kml" | "json");
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
