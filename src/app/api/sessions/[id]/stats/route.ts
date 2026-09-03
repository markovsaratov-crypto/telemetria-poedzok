// GET /api/sessions/[id]/stats — детальная статистика по сессии.
// Возвращает: distance, duration, avgSpeed, maxSpeed, avgAltitude, elevationGain/loss, movingTime, idleTime
// + v2.9: полный набор метрик методологии (62 метрики в 8 группах + routeId) + план-факт из TrafficJob.
// v2.9: AvgSpeed использует ActiveDuration (§4.11), movingTime/idleTime из state machine (§4.6/§4.7).
//
// v2.17.0: весь расчёт ВЫНЕСЕН в src/lib/session-stats.ts (единый конвейер с
// GET /api/stats/batch — код один, цифры одинаковые). Роут остаётся тонкой
// обёрткой: auth → выборка сессии с точками → конвейер → план-факт.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus"; // v2.16.0 (I1): общая corpus-калибровка (один JOIN вместо N+1)
import { computeSessionStats, loadPlanFacts, composeRoute } from "@/lib/session-stats"; // v2.17.0: единый конвейер
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
    const session = await db.session.findUnique({
      where: { id },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        deletedAt: true,
        routeHash: true,    // v2.9 §10.0: детерминированный хэш маршрута
        topologyHash: true, // v2.9 §10.0: 8-char хэш топологии
        gpsPoints: {
          orderBy: { timestamp: "asc" },
          select: { lat: true, lon: true, speed: true, altitude: true, accuracy: true, bearing: true, timestamp: true },
        },
      },
    });

    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const rawPoints = session.gpsPoints.map((p) => ({
      ...p,
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
      { id, startTime: session.startTime, endTime: session.endTime, routeHash: session.routeHash, topologyHash: session.topologyHash },
      rawPoints,
      ecoBaselines
    );

    if (result.kind === "empty") {
      // нормализация скоростей обнулила ряд — форма прежнего early-return
      return json(result.payload, 200, { "X-Request-Id": requestId });
    }

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
