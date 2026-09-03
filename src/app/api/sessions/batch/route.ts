// POST /api/sessions/batch — получить несколько сессий по IDs за один запрос.
// Body: { ids: string[] } (max 10). Возвращает { sessions: Session[] } с точками.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { z } from "zod";

const zBatchBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(10),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zBatchBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }

    const sessions = await db.session.findMany({
      where: {
        id: { in: parsed.data.ids },
        deletedAt: null,
      },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        status: true,
        gpsPoints: {
          orderBy: { timestamp: "asc" },
          select: {
            lat: true,
            lon: true,
            speed: true,
            altitude: true,
            timestamp: true,
          },
        },
      },
    });

    // Number(timestamp) для JSON-сериализации (BigInt)
    const result = sessions.map((s) => {
      const pts = (s.gpsPoints ?? []) as Array<Record<string, unknown>>; // v2.18.0: типизированный db
      return {
        ...s,
        gpsPoints: pts.map((p) => ({
          ...p,
          timestamp: Number(p.timestamp),
        })),
      };
    });

    return json({ sessions: result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch sessions error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
