// GET /api/sessions/[id]/route-comparison — сравнительные метрики сессии против её routeHash-группы
// (v2.9 §10.1–§10.5): RouteAvg/Best/Worst/StdDev, ранг, перцентиль, vsAvg%,
// RouteTrafficPattern (8×3ч), RouteDayOfWeekPattern (пн–вс), RouteTrend (Theil-Sen).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { compareSessionWithGroup } from "@/lib/route-comparison";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const comparison = await compareSessionWithGroup(id);
    if (!comparison) {
      // Сессии без routeHash (нет ActiveTrip или единственная поездка) — 404 с пояснением
      return json(
        { error: "Not found", reason: "no_route_group", message: "Сессия не входит ни в одну routeHash-группу (нет активной поездки)" },
        404,
        { "X-Request-Id": requestId }
      );
    }
    return json(comparison, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Route comparison error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
