// GET /api/plan/[sessionId] — план маршрута для сессии (§4.5)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { sessionId } = await params;
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        gpsPoints: { orderBy: { timestamp: "asc" }, take: 1 },
        route: true,
        trafficJobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const lastJob = session.trafficJobs[0];
    const traffic = lastJob?.result
      ? JSON.parse(lastJob.result)
      : { status: lastJob?.status ?? "pending", trafficFetched: false };

    // Если есть точки — строим маршрут по первой/последней точке (через кэш)
    let route: unknown = null;
    if (session.gpsPoints.length > 0) {
      const p = session.gpsPoints[0];
      // Используем route сессии если задан
      if (session.route) {
        route = {
          routeId: session.route.id,
          name: session.route.name,
          startLat: session.route.startLat,
          startLon: session.route.startLon,
          endLat: session.route.endLat,
          endLon: session.route.endLon,
        };
      } else {
        route = { startLat: p.lat, startLon: p.lon };
      }
    }

    return json(
      {
        sessionId: session.id,
        route,
        traffic,
        status: lastJob?.status ?? "pending",
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Plan by session error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
