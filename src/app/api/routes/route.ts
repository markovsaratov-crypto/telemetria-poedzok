// CRUD /api/routes — избранные маршруты (§4.6)
import { NextRequest } from "next/server";
import { zRouteBody } from "@/lib/validation";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const routes = await db.route.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { sessions: true } } },
    });
    return json({ routes }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Routes list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zRouteBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }

    const route = await db.route.create({ data: parsed.data });
    await writeAudit({
      action: "route.create",
      targetId: route.id,
      targetType: "Route",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      metadata: { name: route.name },
    });
    return json({ route }, 201, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Route create error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
