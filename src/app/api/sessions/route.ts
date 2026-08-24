// GET /api/sessions — список с курсорной пагинацией + фильтры (§4.2)
import { NextRequest } from "next/server";
import { zSessionsQuery } from "@/lib/validation";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const parsed = zSessionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "Invalid query", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const q = parsed.data;

    const where: Record<string, unknown> = {
      deletedAt: null,
    };
    if (q.olderThan) where.endTime = { lt: new Date(q.olderThan) };
    if (q.before) where.endTime = { gt: new Date(q.before) };
    if (q.routeId) where.routeId = q.routeId;
    if (q.status) where.status = q.status;
    if (q.deviceId) where.deviceId = { contains: q.deviceId };

    const sessions = await db.session.findMany({
      where,
      orderBy: { startTime: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        status: true,
        routeId: true,
        route: { select: { id: true, name: true } },
      },
    });

    const hasMore = sessions.length > q.limit;
    const items = hasMore ? sessions.slice(0, q.limit) : sessions;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return json({ sessions: items, nextCursor }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Sessions list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
