// GET /api/sessions/[id] — детали сессии с точками (§4.3)
// DELETE /api/sessions/[id] — soft-delete с grace period (§4.10)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";
import { env } from "@/lib/env";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const session = await db.session.findUnique({
      where: { id },
      include: {
        gpsPoints: { orderBy: { timestamp: "asc" } },
        route: true,
        trafficJobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const trafficJob = session.trafficJobs[0];
    const traffic = trafficJob?.result
      ? JSON.parse(trafficJob.result)
      : { status: trafficJob?.status ?? "pending", trafficFetched: false };

    return json(
      {
        id: session.id,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        startTime: session.startTime,
        endTime: session.endTime,
        pointCount: session.pointCount,
        payloadBytes: session.payloadBytes,
        status: session.status,
        route: session.route,
        traffic,
        notes: session.notes,
        tags: session.tags,
        points: session.gpsPoints.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
          altitude: p.altitude,
          accuracy: p.accuracy,
          bearing: p.bearing,
          timestamp: Number(p.timestamp),
        })),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Session detail error", { requestId, error: err instanceof Error ? err.message : String(err) });
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
    const session = await db.session.findUnique({ where: { id }, select: { id: true, deletedAt: true, pointCount: true } });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    await db.session.update({
      where: { id },
      data: { deletedAt: new Date(), status: "deleted" },
    });

    await writeAudit({
      action: "session.delete",
      targetId: id,
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: id,
      metadata: { pointCount: session.pointCount, reason: "user-request", gracePeriodDays: env().GRACE_PERIOD_DAYS },
    });
    inc("session_delete_total", "Session soft-deletes", 1);

    return json({ ok: true, gracePeriodDays: env().GRACE_PERIOD_DAYS }, 204, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Session delete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
