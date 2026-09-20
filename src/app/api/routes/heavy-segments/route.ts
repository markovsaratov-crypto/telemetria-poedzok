// GET /api/routes/heavy-segments — дашборд-виджет «Тяжёлые участки» (v2.9.6).
// Агрегирует худшие P75-хотспоты (§10.6) по ВСЕМ routeHash-группам в один ответ:
// для каждой группы — полилайн-сэмпл + топ-N самых тяжёлых сегментов + счётчики.
// Один запрос вместо N запросов к /api/routes/[id]/hotspots.
// v2.12.0 (D-8): ?period=today|week|d30|all — группы ограничены сессиями периода.
// v2.12.0 (D-7): группы обрабатываются параллельно (Promise.all).
// v2.40.9 (Pack C, N-7): двухслойный кэш ответа (in-memory 60с + KV шлюза
// watermark-ключом) — холодный показ вкладки после ресайкла больше не
// перечитывает ~100–300 тыс. строк точек; точки грузятся ОДИН раз на запрос
// (до этого loadGroupSessions и computeGroupHotspots читали их дважды).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { SESSION_CACHE_VERSION } from "@/lib/session-cache";
import {
  listRouteGroups,
  loadGroupSessions,
  loadGroupPointsChunked,
  computeGroupHotspots,
  routePeriodSinceIso,
} from "@/lib/route-comparison";
import { cachedHotspotResponse } from "@/lib/routes-hotspot-cache";

export const dynamic = "force-dynamic";

const MAX_GROUPS = 8; // защита от деградации при росте числа маршрутов
const TOP_PER_GROUP = 3;
// v2.38.1 (ревью F16): лимит сессий на группу в хотспот-расчёте — 50 САМЫХ
// СВЕЖИХ (loadGroupSessions возвращает startTime ASC → slice(-50)). Полный год
// commuter-группы (сотни сессий) не меняет картину «тяжёлых участков сейчас»,
// но умножал и CPU (хотспот-конвейер), и число чанков к D1-шлюзу ×8 групп.
const HOTSPOT_SESSION_LIMIT = 50;

interface GroupAnswer {
  routeHash: string;
  sessionCount: number;
  totalSegments: number;
  hotspotCount: number;
  avgDistanceM: number | null;
  lastSeen: string;
  endCoord: { lat: number; lon: number } | null;
  polylineSample: { lat: number; lon: number }[];
  worstHotspots: Array<{ segmentId: string; p75: number; a: { lat: number; lon: number } | null; b: { lat: number; lon: number } | null }>;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    // v2.16.0 (B-4): tzOffsetMin — «сегодня» в поясе клиента (как /api/stats/batya)
    const tzRaw = Number(url.searchParams.get("tzOffsetMin"));
    const tzOffsetMin = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 15 * 60 ? Math.round(tzRaw) : 0;
    const period = url.searchParams.get("period") ?? "all";
    const sinceIso = routePeriodSinceIso(period, tzOffsetMin);

    // v2.23.0: изоляция данных
    const scope = dataScopeFor(auth);
    const scopeKey = scope?.userId ?? "owner";

    // v2.40.9 (Pack C, N-7): watermark-кэш. Состав групп (routeHash:count:lastSeen)
    // + период + tz + версия кэша сессий: новая сессия/удаление/релиз конвейера
    // → другой watermark → другой ключ → честный пересчёт; TTL 1 ч — страховка.
    // listRouteGroups — дешёвый GROUP BY по метам Session (~сотня строк), он же
    // источник состава для watermark: «заплатить сотней строк, чтобы не платить
    // сотнями тысяч» — при повторе в течение 60 с и этого не будет (слой памяти).
    const groupsInfo = await listRouteGroups(sinceIso, scope);

    const { data, cache, watermark } = await cachedHotspotResponse<GroupAnswer[]>(
      [scopeKey, period, String(tzOffsetMin)],
      [
        ...groupsInfo
          .slice(0, MAX_GROUPS)
          .map((g) => `${g.routeHash}:${g.sessionCount}:${g.lastSeen}`),
        `period:${period}`,
        `tz:${tzOffsetMin}`,
        `since:${sinceIso ?? "all"}`,
        `scv:${SESSION_CACHE_VERSION}`,
      ],
      () => computeHeavySegments(groupsInfo, sinceIso, scope)
    );

    return json(
      {
        groups: data,
        groupCount: data.length,
        groupsSkipped: Math.max(0, groupsInfo.length - MAX_GROUPS),
        totalHotspotSegments: data.reduce((acc, g) => acc + g.hotspotCount, 0),
        worstP75: data.reduce<number | null>(
          (acc, g) =>
            g.worstHotspots.length > 0 && (acc == null || g.worstHotspots[0].p75 < acc)
              ? g.worstHotspots[0].p75
              : acc,
          null
        ),
        // v2.40.9: источник ответа — наблюдаемость кэша (memory|kv|miss|error)
        cache: { source: cache, watermark },
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

/**
 * Тяжёлое вычисление (только на промахе кэша). Точки грузятся ОДНИМ набором
 * чанков на ВСЕ группы запроса и передаются в loadGroupSessions И
 * computeGroupHotspots (N-7: до этого каждый читал их сам — двойной расход).
 */
async function computeHeavySegments(
  groupsInfo: Awaited<ReturnType<typeof listRouteGroups>>,
  sinceIso: string | null,
  scope: ReturnType<typeof dataScopeFor>
): Promise<GroupAnswer[]> {
  const selected = groupsInfo.slice(0, MAX_GROUPS);
  // Единая загрузка точек всех сессий всех групп (потенциально пересекающихся
  // по сессиям — дедупликация id экономит квоту на повторных маршрутах).
  const allSessionIds = [
    ...new Set(
      selected.flatMap((g) => {
        // порядок сессий внутри группы НЕ известен до loadGroupSessions —
        // грузим по group.sessionIds (тем же фильтром sinceIso), избыток
        // отсекается slice(-50) внутри группы ниже; список идемпотентен.
        return g.sessionIds;
      })
    ),
  ];
  const pointsBySession = await loadGroupPointsChunked(allSessionIds);

  // v2.12.0 (D-7): параллельная обработка групп (~8 с → ~1 с).
  const groupResults = await Promise.all(
    selected.map(async (g) => {
      // v2.38.1 (F16): в хотспот-расчёт — только свежие HOTSPOT_SESSION_LIMIT
      // сессий группы (sessionCount в ответе — по всей группе)
      const sessions = (await loadGroupSessions(g.routeHash, sinceIso, scope, { pointsBySession })).slice(
        -HOTSPOT_SESSION_LIMIT
      );
      if (sessions.length === 0) return null;
      const { hotspots, totalSegments, polyline } = await computeGroupHotspots(g.routeHash, sessions, {
        pointsBySession,
      });
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

      const answer: GroupAnswer = {
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
      return answer;
    })
  );
  return groupResults.filter((g): g is GroupAnswer => g != null);
}
