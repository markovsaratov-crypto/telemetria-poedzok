// GET /api/audit — журнал аудита (§6.8). Bearer ADMIN_TOKEN или cookie.
import { NextRequest } from "next/server";
import { zAuditQuery } from "@/lib/validation";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const parsed = zAuditQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "Invalid query", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const q = parsed.data;

    const where: Record<string, unknown> = {};
    if (q.action) where.action = { contains: q.action };
    if (q.actorType) where.actorType = q.actorType;
    if (q.targetType) where.targetType = q.targetType;

    const logs = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = logs.length > q.limit;
    const items = hasMore ? logs.slice(0, q.limit) : logs;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return json({ logs: items, nextCursor }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Audit list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
