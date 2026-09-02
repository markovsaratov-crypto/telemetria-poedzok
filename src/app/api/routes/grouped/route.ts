// GET /api/routes/grouped — routeHash-группы концептуально одинаковых маршрутов (v2.9 §10.0).
// Возвращает группы с агрегатами ActiveDuration (§10.1/§10.2) для UI «Маршруты».
// v2.12.0 (D-8): ?period=today|week|d30|all — группы ограничены сессиями периода.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { listRouteGroups, routePeriodSinceIso } from "@/lib/route-comparison";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const sinceIso = routePeriodSinceIso(url.searchParams.get("period"));
    const groups = await listRouteGroups(sinceIso);
    return json({ groups, total: groups.length }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Route groups error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
