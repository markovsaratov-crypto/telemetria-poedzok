// GET /api/routes/heavy-segments — дашборд-виджет «Тяжёлые участки» (v2.9.6).
// Агрегирует худшие P75-хотспоты (§10.6) по ВСЕМ routeHash-группам в один ответ:
// для каждой группы — полилайн-сэмпл + топ-N самых тяжёлых сегментов + счётчики.
// Один запрос вместо N запросов к /api/routes/[id]/hotspots.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import {
  listRouteGroups,
  loadGroupSessions,
  computeGroupHotspots,
} from "@/lib/route-comparison";

export const dynamic = "force-dynamic";

const MAX_GROUPS = 8; // защита от деградации при росте числа маршрутов
const TOP_PER_GROUP = 3;

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const groupsInfo = await listRouteGroups();
    const groups: unknown[] = [];
    let totalHotspotSegments = 0;
    let worstP75: number | null = null;

    for (const g of groupsInfo.slice(0, MAX_GROUPS)) {
      const sessions = await loadGroupSessions(g.routeHash);
      if (sessions.length === 0) continue;
      const { hotspots, totalSegments, polyline } = await computeGroupHotspots(g.routeHash, sessions);
      if (totalSegments === 0) continue;

      // Топ-N худших: P75 по возрастанию (меньше = тяжелее)
      const worst = [...hotspots]
        .sort((a, b) => a.p75 - b.p75)
        .slice(0, TOP_PER_GROUP)
        .map((h) => ({
          segmentId: h.segmentId,
          p75: h.p75,
          a: h.a,
          b: h.b,
        }));
      if (worst.length > 0 && (worstP75 == null || worst[0].p75 < worstP75)) {
        worstP75 = worst[0].p75;
      }
      totalHotspotSegments += hotspots.length;

      groups.push({
        routeHash: g.routeHash,
        sessionCount: g.sessionCount,
        totalSegments,
        hotspotCount: hotspots.length,
        avgDistanceM: g.avgDistanceM,
        lastSeen: g.lastSeen,
        polylineSample: polyline.slice(0, 60), // для мини-карты (прорежено)
        worstHotspots: worst,
      });
    }

    return json(
      {
        groups,
        groupCount: groups.length,
        groupsSkipped: Math.max(0, groupsInfo.length - MAX_GROUPS),
        totalHotspotSegments,
        worstP75,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Heavy segments error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
