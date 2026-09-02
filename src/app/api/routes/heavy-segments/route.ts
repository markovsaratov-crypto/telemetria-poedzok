// GET /api/routes/heavy-segments — дашборд-виджет «Тяжёлые участки» (v2.9.6).
// Агрегирует худшие P75-хотспоты (§10.6) по ВСЕМ routeHash-группам в один ответ:
// для каждой группы — полилайн-сэмпл + топ-N самых тяжёлых сегментов + счётчики.
// Один запрос вместо N запросов к /api/routes/[id]/hotspots.
// v2.12.0 (D-8): ?period=today|week|d30|all — группы ограничены сессиями периода.
// v2.12.0 (D-7): группы обрабатываются параллельно (Promise.all).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import {
  listRouteGroups,
  loadGroupSessions,
  computeGroupHotspots,
  routePeriodSinceIso,
} from "@/lib/route-comparison";

export const dynamic = "force-dynamic";

const MAX_GROUPS = 8; // защита от деградации при росте числа маршрутов
const TOP_PER_GROUP = 3;

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const sinceIso = routePeriodSinceIso(url.searchParams.get("period"));

    const groupsInfo = await listRouteGroups(sinceIso);
    let totalHotspotSegments = 0;
    let worstP75: number | null = null;

    // v2.12.0 (D-7): параллельная обработка групп (раньше — последовательный
    // цикл с двумя await на группу, ~1 с × 8 групп).
    const groupResults = await Promise.all(
      groupsInfo.slice(0, MAX_GROUPS).map(async (g) => {
        const sessions = await loadGroupSessions(g.routeHash, sinceIso);
        if (sessions.length === 0) return null;
        const { hotspots, totalSegments, polyline } = await computeGroupHotspots(g.routeHash, sessions);
        if (totalSegments === 0) return null;

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
        totalHotspotSegments += hotspots.length;

        return {
          routeHash: g.routeHash,
          sessionCount: g.sessionCount,
          totalSegments,
          hotspotCount: hotspots.length,
          avgDistanceM: g.avgDistanceM,
          lastSeen: g.lastSeen,
          // v2.12.0 (Q3): координаты финиша группы — для адресной идентификации маршрута
          endCoord: g.endCoord ?? null,
          polylineSample: polyline.slice(0, 60), // для мини-карты (прорежено)
          worstHotspots: worst,
        };
      })
    );

    const groups = groupResults.filter((g): g is NonNullable<typeof g> => g != null);
    for (const g of groups) {
      if (g.worstHotspots.length > 0 && (worstP75 == null || g.worstHotspots[0].p75 < worstP75)) {
        worstP75 = g.worstHotspots[0].p75;
      }
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
