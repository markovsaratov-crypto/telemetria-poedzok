// POST /api/sessions/bulk-delete — массовое soft-delete сессий по IDs.
// Body: { ids: string[] } (max 50). Возвращает { deleted: number, errors: string[] }.
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";

const zBulkDelete = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zBulkDelete.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }

    const ids = parsed.data.ids;
    const now = new Date();

    // Находим существующие неудалённые сессии
    const sessions = await db.session.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      select: { id: true, pointCount: true },
    });

    const toDelete = sessions.map((s) => s.id);
    const notFound = ids.filter((id) => !toDelete.includes(id));

    if (toDelete.length === 0) {
      return json(
        { deleted: 0, errors: notFound.map((id) => `${id}: not found or already deleted`) },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // Массовое soft-delete
    const result = await db.session.updateMany({
      where: { id: { in: toDelete } },
      data: { deletedAt: now, status: "deleted" },
    });

    // Audit log для каждой сессии
    for (const s of sessions) {
      await writeAudit({
        action: "session.delete",
        targetId: s.id,
        targetType: "Session",
        actorType: auth.via === "cookie" ? "user" : "system",
        actorId: auth.via === "cookie" ? "owner" : "api",
        sessionId: s.id,
        metadata: {
          pointCount: s.pointCount,
          reason: "bulk-delete",
          gracePeriodDays: env().GRACE_PERIOD_DAYS,
        },
      });
    }

    return json(
      {
        deleted: result.count,
        errors: notFound.map((id) => `${id}: not found or already deleted`),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Bulk delete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
