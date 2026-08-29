// GET /api/routes/[id]/gpx — GPX-экспорт канонического маршрута routeHash-группы (v2.9.1).
// [id] = routeHash (16-hex). Возвращает GPX 1.1-трек канонического полилайна группы:
// сегменты последнего completed TrafficJob либо активная часть первой сессии (§10.0).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { groupRouteGpx } from "@/lib/route-comparison";

const GPX_MIME = "application/gpx+xml; charset=utf-8";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const gpx = await groupRouteGpx(id);
    if (gpx == null) {
      return json({ error: "Not found", reason: "no_route_group_or_polyline" }, 404, { "X-Request-Id": requestId });
    }

    return new Response(gpx, {
      status: 200,
      headers: {
        "Content-Type": GPX_MIME,
        "Content-Disposition": `attachment; filename="route-${id}.gpx"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    logger.error("Route GPX export error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
