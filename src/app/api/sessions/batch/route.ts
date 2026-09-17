// POST /api/sessions/batch — получить несколько сессий по IDs за один запрос.
// Body: { ids: string[] } (max 10). Возвращает { sessions: Session[] }.
//
// v2.38.2 (ревью F47): ПО УМОЛЧАНИЮ — СВОДКА, НЕ ВЫКАЧКА ТОЧЕК. Прежний
// select gpsPoints в db-обёртке (findMany → fetchGpsPoints ПОСТРОЧНО, N+1)
// тянул ВСЕ точки каждой сессии без лимитов — 10 больших сессий = мегабайты
// JSON; роут существовал параллельно батч-роутам v2.19+ (stats/events/track),
// которые ровно это и решали. Теперь:
//   • default: скаляры + summary (distance/duration/maxSpeed/avgSpeed из
//     персистентного кэша Session.statsCache — один метa-запрос IN, БЕЗ
//     точек; кэша нет → summary:null, полные статы — /api/stats/batch);
//     поле gpsPoints СОХРАНЕНО (пустой массив) — форма ответа обратно
//     совместима: старые потребители читают поле, не падая;
//   • ?include=points (или body {include:"points"}) — оп-ин на треки:
//     равномерный сэмпл ≤ BATCH_MAX_POINTS на сессию (первая/последняя
//     точки всегда), флаг pointsTruncated; выкачка — батчем в db-обёртке
//     (F47/F54: чанки ≤8 сессий, один IN-запрос на чанк, ≤90 параметров).
// Активных потребителей выкачки в UI нет (useBatchSessions вызовов не
// имеет); полный трек — /api/track/batch, полный конвейер — /api/stats/batch.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionScopeWhere } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { isSessionCacheFresh, loadSessionMetasWithCache, parseCachedJson } from "@/lib/session-cache";
import type { SessionStatsResult } from "@/lib/session-stats";

const zBatchBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(10),
  // v2.38.2 (F47): оп-ин на треки — эквивалент ?include=points
  include: z.enum(["points"]).optional(),
});

// v2.38.2 (F47): кап точек на сессию при include=points — ответ ограничен
// ≤10×2000 точек вместо мегабайт; равномерный сэмпл сохраняет форму трека
// (та же схема, что MAX_SHARE_POINTS в share.ts).
const BATCH_MAX_POINTS = 2000;

/** Равномерный сэмпл ≤cap: шаг (n-1)/(cap-1), первая/последняя — всегда. */
function evenSample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (cap - 1);
  for (let i = 0; i < cap - 1; i++) out.push(arr[Math.round(i * step)]);
  out.push(arr[arr.length - 1]); // финиш — всегда
  return out;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zBatchBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    // v2.38.2 (F47): треки — только явный оп-ин (?include=points | body.include)
    const includePoints =
      parsed.data.include === "points" ||
      request.nextUrl.searchParams.get("include") === "points";

    const sessions = await db.session.findMany({
      where: {
        id: { in: parsed.data.ids },
        deletedAt: null,
        // v2.23.0: изоляция данных — чужие id молча исключаются (как несуществующие)
        ...sessionScopeWhere(dataScopeFor(auth)),
      },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        status: true,
        // v2.38.2 (F47): точки — только при оп-ине; батч-доставка в db.ts (F54)
        ...(includePoints ? { gpsPoints: { orderBy: { timestamp: "asc" as const } } } : {}),
      },
    });

    // v2.38.2 (F47): сводки — из персистентного statsCache (один метa-запрос
    // IN по ids+scope, без точек). Протухший/отсутствующий кэш → summary:null
    // (запись живая/первая загрузка после релиза) — полный конвейер с
    // write-through пересчётом живёт в /api/stats/batch. Свежесть — новым
    // API F51 isSessionCacheFresh(meta, ["stats"]): версия схемы + состав
    // точек + пригодность самого поля (маркер oversized = честное «не свежо»)
    // — без ручной проверки parseCachedJson(...) == null.
    const metas = await loadSessionMetasWithCache(parsed.data.ids, dataScopeFor(auth), { stats: true });

    const result = sessions.map((s) => {
      const pts = (s.gpsPoints ?? []) as Array<Record<string, unknown>>; // v2.18.0: типизированный db
      const sampled = includePoints ? evenSample(pts, BATCH_MAX_POINTS) : pts;
      const meta = metas.get(String(s.id));
      const stats = meta && isSessionCacheFresh(meta, ["stats"])
        ? parseCachedJson<SessionStatsResult>(meta.statsCache)
        : null;
      const payload = stats ? stats.payload : null;
      return {
        ...s,
        // Number(timestamp) для JSON-сериализации (BigInt); 5 полей точки —
        // прежняя проекция ответа, форма не изменилась
        gpsPoints: sampled.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
          altitude: p.altitude,
          timestamp: Number(p.timestamp),
        })),
        pointsTruncated: sampled.length < pts.length, // v2.38.2 (F47): урезан сэмплом
        summary: payload
          ? {
              // дистанция/длительность — как в payload статов (FIX-C1: distance
              // — активная часть поездки; duration — вся запись)
              distance: payload.distance,
              duration: payload.duration,
              maxSpeed: payload.maxSpeed,
              avgSpeed: payload.avgSpeed,
              source: "statsCache",
            }
          : null,
      };
    });

    return json({ sessions: result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch sessions error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
