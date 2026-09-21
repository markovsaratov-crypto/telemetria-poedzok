// GET /api/sessions/[id]/stats — детальная статистика по сессии.
// Возвращает: distance, duration, avgSpeed, maxSpeed, avgAltitude, elevationGain/loss, movingTime, idleTime
// + v2.9: полный набор метрик методологии (62 метрики в 8 группах + routeId) + план-факт из TrafficJob.
// v2.9: AvgSpeed использует ActiveDuration (§4.11), movingTime/idleTime из state machine (§4.6/§4.7).
//
// v2.17.0: весь расчёт ВЫНЕСЕН в src/lib/session-stats.ts (единый конвейер с
// GET /api/stats/batch — код один, цифры одинаковые). Роут остаётся тонкой
// обёрткой: auth → выборка сессии с точками → конвейер → план-факт.
//
// v2.38.2 · F41: роут читает ПЕРСИСТЕНТНЫЙ кэш предрасчёта Session.statsCache
// (src/lib/session-cache.ts) — детальная страница поллит этот роут каждые 15 с
// для живых записей, и раньше КАЖДЫЙ вызов грузил все точки + полный CPU-конвейер,
// а EcoScore деталей мог расходиться с батч-роутом (базлайны на момент записи
// vs текущий корпус). Теперь: свежий кэш → готовый payload без точек (как
// /api/stats/batch с v2.27.0); протухший/отсутствующий — прежний live-расчёт
// с write-through перезаписью кэша. route (план-факт) — по-прежнему из живого
// TrafficJob (воркер завершает джобы после финализации — кэшировать нельзя).
// Свежесть — тот же критерий, что у батча: isSessionCacheFresh (версия схемы +
// cachePointCount === pointCount; инжест инкрементит pointCount → живая запись
// автоматически пересчитывается).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus"; // v2.16.0 (I1): общая corpus-калибровка (один JOIN вместо N+1)
import { computeSessionStats, loadPlanFacts, composeRoute, type SessionStatsResult } from "@/lib/session-stats"; // v2.17.0: единый конвейер
import {
  loadSessionMetasWithCache,
  getCachedPayload,
  persistSessionCaches,
} from "@/lib/session-cache"; // v2.38.2 · F41: персистентный кэш предрасчёта; v2.41.0 (P0-A): честность по payload
import { trackLatency } from "@/lib/latency"; // P2-16: замер api_latency_p95

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;

    // v2.38.2 · F41: мета с кэш-колонками вместо findUnique с точками — один
    // лёгкий запрос. Чужая сессия не попадает в Map (scope-предикат) → 404,
    // как раньше («неотличима от отсутствующей»); deletedAt → тоже 404.
    const scope = dataScopeFor(auth);
    const metas = await loadSessionMetasWithCache([id], scope, { stats: true });
    const meta = metas.get(id);
    if (!meta || meta.deleted) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // ——— свежий персистентный кэш: готовый payload, БЕЗ точек и конвейера ———
    // v2.41.0 (P0-A, N-8): свежесть — по штампу конвейера в самом payload
    const fresh = getCachedPayload<SessionStatsResult>(meta, "stats");
    if (fresh) {
      if (fresh.kind === "empty") {
        trackLatency(request); // P2-16
        return json(fresh.payload, 200, { "X-Request-Id": requestId });
      }
      const facts = await loadPlanFacts([id]);
      const route = composeRoute(facts.get(id), fresh.activeDistanceM, fresh.actualDurationSec, fresh.avgSpeedRawMs);
      trackLatency(request); // P2-16
      return json({ ...fresh.payload, route }, 200, { "X-Request-Id": requestId });
    }

    // ——— протухший/отсутствующий кэш: live-расчёт (прежний путь) ———
    // Точки — отдельным запросом только здесь: мета уже закрыла вопросы
    // существования/видимости/удаления, тянуть их при свежем кэше незачем.
    // Гонка (сессию удалили между двумя запросами) → null → 404, как раньше.
    const session = await db.session.findUnique({
      where: { id },
      select: {
        gpsPoints: {
          orderBy: { timestamp: "asc" },
          select: { lat: true, lon: true, speed: true, altitude: true, accuracy: true, bearing: true, timestamp: true },
        },
      },
    });
    if (!session) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // v2.18.0: типизированный db — gpsPoints приходит unknown, приводим к строке интерфейса
    const gpsPoints = (session.gpsPoints ?? []) as Array<Record<string, unknown>>;
    const rawPoints = gpsPoints.map((p) => ({
      lat: Number(p.lat),
      lon: Number(p.lon),
      speed: p.speed == null ? null : Number(p.speed),
      altitude: p.altitude == null ? null : Number(p.altitude),
      accuracy: p.accuracy == null ? null : Number(p.accuracy),
      bearing: p.bearing == null ? null : Number(p.bearing),
      timestamp: Number(p.timestamp),
    }));

    if (rawPoints.length === 0) {
      return json(
        { sessionId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // v2.10.0 R6.1: corpus-калибровка EcoScore (§7.3) — кэш 5 мин, общий с батч-роутом
    const ecoBaselines = await getCorpusEcoBaselines();
    const result = computeSessionStats(
      {
        id,
        startTime: meta.startTime,
        endTime: meta.endTime,
        routeHash: meta.routeHash,
        topologyHash: meta.topologyHash,
      },
      rawPoints,
      ecoBaselines
    );

    if (result.kind === "empty") {
      // нормализация скоростей обнулила ряд — форма прежнего early-return
      return json(result.payload, 200, { "X-Request-Id": requestId });
    }

    // v2.38.2 · F41: write-through — перезапись протухшего кэша (как в
    // /api/stats/batch): следующий полл детали уже читает кэш. cachePointCount
    // = pointCount меты НА МОМЕНТ SELECT (см. persistSessionCaches): инжест
    // инкрементит мету → новые точки инвалидируют кэш. Сбой записи — не роняет
    // ответ (warn внутри persistSessionCaches).
    await persistSessionCaches(
      [{ id, cachePointCount: meta.pointCount ?? 0, statsJson: JSON.stringify(result) }],
      ["stats"]
    );

    // P1-7: план-факт из завершённого TrafficJob (FIX-C2: фактическое время = ActiveDuration)
    const facts = await loadPlanFacts([id]);
    const route = composeRoute(facts.get(id), result.activeDistanceM, result.actualDurationSec, result.avgSpeedRawMs);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    return json(
      { ...result.payload, route },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Session stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
