// /api/routes/[id] — PATCH, DELETE (§4.6)
import { NextRequest } from "next/server";
import { zRouteUpdate } from "@/lib/validation";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const { id } = await params;
    const route = await db.route.findUnique({
      where: { id },
      include: { _count: { select: { sessions: true } } },
    });
    if (!route) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    return json({ route }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Route get error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = zRouteUpdate.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const route = await db.route.update({ where: { id }, data: parsed.data });
    return json({ route }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Route patch error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const { id } = await params;
    await db.route.delete({ where: { id } });
    await writeAudit({
      action: "route.delete",
      targetId: id,
      targetType: "Route",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
    });
    return new Response(null, { status: 204, headers: { "X-Request-Id": requestId } });
  } catch (err) {
    logger.error("Route delete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
