// GET /api/routes/[id]/trend — Theil-Sen-тренд activeDuration по сессиям routeHash-группы (v2.9 §10.5).
// [id] = routeHash (16-hex) либо UUID админского маршрута (тогда группа = сессии по FK routeId).
// Возвращает: slope (сек/день), intercept, CI 95% (bootstrap при n > ROUTE_TREND_BOOTSTRAP_THRESHOLD),
// rating (improving/stable/degrading/insufficient_data), историю activeDuration по датам.
// v2.10.1: добавлены trafficPattern (8x3ч, §10.3) + dayOfWeekPattern (7д, §10.4) — для блока 10
// аналитики (Частые маршруты), чтобы один запрос давал все агрегаты группы.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import {
  loadGroupSessions,
  routeTrend,
  routeDurationStats,
  routeTrafficPattern,
  routeDayOfWeekPattern,
} from "@/lib/route-comparison";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;

    // 1) [id] как routeHash
    let sessions = await loadGroupSessions(id);

    // 2) Fallback: [id] как UUID админского Route → сессии по FK
    if (sessions.length === 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      const res = await libsql.execute({
        sql: "SELECT routeHash FROM Session WHERE routeId = ? AND deletedAt IS NULL AND routeHash IS NOT NULL LIMIT 1",
        args: [id],
      });
      if (res.rows.length > 0) {
        const routeHash = String((res.rows[0] as unknown as Record<string, unknown>).routeHash);
        sessions = await loadGroupSessions(routeHash);
      }
    }

    if (sessions.length === 0) {
      return json({ error: "Not found", reason: "no_route_group" }, 404, { "X-Request-Id": requestId });
    }

    const trend = routeTrend(sessions);
    const stats = routeDurationStats(sessions);
    // v2.10.1: paterns нужны блоку 10 (Частые маршруты) — без них пришлось бы дёргать
    // /api/sessions/[id]/route-comparison для каждой группы. Один запрос эффективнее.
    const trafficPattern = routeTrafficPattern(sessions);
    const dayOfWeekPattern = routeDayOfWeekPattern(sessions);
    const history = [...sessions]
      .sort((a, b) => a.activeStartTime - b.activeStartTime)
      .map((s) => ({
        sessionId: s.sessionId,
        date: new Date(s.activeStartTime).toISOString(),
        activeDurationSec: Math.round(s.activeDuration),
        deviceId: s.deviceId,
      }));

    return json(
      {
        routeId: id,
        groupSize: sessions.length,
        trend,
        stats,
        history,
        trafficPattern, // §10.3 — 8 бакетов по 3 часа
        dayOfWeekPattern, // §10.4 — Пн..Вс
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Route trend error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
