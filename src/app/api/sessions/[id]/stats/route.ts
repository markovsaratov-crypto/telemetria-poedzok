// GET /api/sessions/[id]/stats — детальная статистика по сессии.
// Возвращает: distance, duration, avgSpeed, maxSpeed, avgAltitude, elevationGain/loss, movingTime, idleTime
// + v2.9: полный набор метрик методологии (62 метрики в 8 группах + routeId) + план-факт из TrafficJob.
// v2.9: AvgSpeed использует ActiveDuration (§4.11), movingTime/idleTime из state machine (§4.6/§4.7).
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { computeMethodologyMetrics } from "@/lib/metrics-methodology";
import { avgSpeedMs, meanPointSpeedMs, maxSpeedMs } from "@/lib/kpi"; // P2-13: единый источник KPI
import { haversineM } from "@/lib/geo"; // P2-14: канонический гаверсинус
import { trackLatency } from "@/lib/latency"; // P2-16: замер api_latency_p95

// P1-7: план-фактные отклонения и трафик-блок из результата ворчера (§6.3/§6.6/§6.7/§6.8 методологии)
interface RoutePlanFact {
  provider: string | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  trafficFetched: boolean;
  trafficDurationSec: number | null;
  timeLostToTrafficSec: number | null;
  durationDeviationPct: number | null;
  distanceDeviationPct: number | null;
  speedDeviationPct: number | null;
}

async function computePlanFact(
  sessionId: string,
  actualDistanceM: number,
  actualDurationSec: number,
  actualAvgSpeed: number | null
): Promise<RoutePlanFact> {
  const empty: RoutePlanFact = {
    provider: null,
    planDistanceM: null,
    planDurationSec: null,
    trafficFetched: false,
    trafficDurationSec: null,
    timeLostToTrafficSec: null,
    durationDeviationPct: null,
    distanceDeviationPct: null,
    speedDeviationPct: null,
  };
  try {
    const res = await libsql.execute({
      sql: "SELECT status, result FROM TrafficJob WHERE sessionId = ? AND status = 'completed' ORDER BY updatedAt DESC LIMIT 1",
      args: [sessionId],
    });
    if (res.rows.length === 0) return empty;
    const row = res.rows[0] as Record<string, unknown>;
    if (!row.result) return empty;
    let parsed: any;
    try { parsed = JSON.parse(String(row.result)); } catch { return empty; }
    if (!parsed || typeof parsed !== "object") return empty;
    const provider = parsed.provider ? String(parsed.provider) : null;

    // План: дистанция провайдера — всегда плановая (геометрия маршрута).
    // Время: для OSRM — свободный поток (план); для 2ГИС total_duration включает пробки →
    // план по времени считаем по базовой линии гаверсинус/40 км/ч (§3.2), трафик — от 2ГИС.
    const distM = Number(parsed.distanceM) || null;
    const durS = Number(parsed.durationSec) || null;
    const trafficFetched = !!parsed.trafficFetched;
    const planDistanceM = distM;
    let planDurationSec = trafficFetched ? null : durS;
    let trafficDurationSec = trafficFetched ? durS : null;
    let timeLostToTrafficSec: number | null = null;

    if (trafficFetched && durS && distM) {
      const direct =
        Array.isArray(parsed.segments) && parsed.segments.length >= 2
          ? haversineM(parsed.segments[0].lat, parsed.segments[0].lon, parsed.segments[parsed.segments.length - 1].lat, parsed.segments[parsed.segments.length - 1].lon)
          : null;
      if (direct && direct > 1) {
        const baselineDur = Math.round((direct / 1000 / 40) * 3600); // гаверсинус @ 40 км/ч
        planDurationSec = baselineDur;
        timeLostToTrafficSec = durS - baselineDur; // §6.8
      }
    }

    const pct = (actual: number, plan: number) =>
      plan > 0 ? Math.round(((actual - plan) / plan) * 1000) / 10 : null;

    let speedDeviationPct: number | null = null;
    if (actualAvgSpeed != null && planDistanceM && planDurationSec && planDurationSec > 0) {
      const planSpeed = planDistanceM / planDurationSec;
      speedDeviationPct = planSpeed > 0 ? Math.round(((actualAvgSpeed - planSpeed) / planSpeed) * 1000) / 10 : null;
    }
    // §6.7: если план по времени недоступен (2ГИС-трафик) — скорость плана = дистанция плана / трафик-время
    if (speedDeviationPct == null && actualAvgSpeed != null && planDistanceM && trafficDurationSec && trafficDurationSec > 0) {
      const trafficSpeed = planDistanceM / trafficDurationSec;
      speedDeviationPct = trafficSpeed > 0 ? Math.round(((actualAvgSpeed - trafficSpeed) / trafficSpeed) * 1000) / 10 : null;
    }

    return {
      provider,
      planDistanceM: planDistanceM ? Math.round(planDistanceM) : null,
      planDurationSec,
      trafficFetched,
      trafficDurationSec,
      timeLostToTrafficSec: timeLostToTrafficSec != null ? Math.round(timeLostToTrafficSec) : null,
      durationDeviationPct: planDurationSec ? pct(actualDurationSec, planDurationSec) : null,
      distanceDeviationPct: planDistanceM ? pct(actualDistanceM, planDistanceM) : null,
      speedDeviationPct,
    };
  } catch {
    return empty;
  }
}

const EARTH_R = 6371000; // (оставлено для совместимости сигнатур; расчёт — в metrics-methodology)
void EARTH_R;

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

    const points = session.gpsPoints.map((p) => ({
      ...p,
      timestamp: Number(p.timestamp),
    }));

    if (points.length === 0) {
      return json(
        { sessionId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // Расчёт дистанции
    let distance = 0;
    let speedSum = 0;
    let speedCount = 0;
    let elevationGain = 0;
    let elevationLoss = 0;
    let prevAlt: number | null = null;

    // P2-13: maxSpeed через единый фильтр выбросов (kpi.ts) — GPS-джиттер раньше
    // давал нереальные значения MaxSpeed на экране
    const maxSpeed = maxSpeedMs(points) ?? 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      // Distance
      if (i > 0) {
        const prev = points[i - 1];
        distance += haversineM(prev.lat, prev.lon, p.lat, p.lon);
      }

      // Speed stats — сумма для meanPointSpeed (НЕ KPI AvgSpeed, см. ниже)
      if (p.speed != null && p.speed >= 0) {
        speedSum += p.speed;
        speedCount++;
      }

      // Elevation
      if (p.altitude != null) {
        if (prevAlt != null) {
          const diff = p.altitude - prevAlt;
          if (diff > 0) elevationGain += diff;
          else elevationLoss += Math.abs(diff);
        }
        prevAlt = p.altitude;
      }
    }

    const startTime = new Date(session.startTime).getTime();
    const endTime = session.endTime
      ? new Date(session.endTime).getTime()
      : points.length > 0
      ? points[points.length - 1].timestamp
      : startTime;
    const durationSec = Math.max(0, (endTime - startTime) / 1000);

    // v2.9: метрики методологии (§12) — state machine + ActiveTrip + CAP EcoScore + новые поведенческие
    const methodology = computeMethodologyMetrics(points, distance, durationSec);
    // v2.9: AvgSpeed = Distance / ActiveDuration (§4.3 + §4.11)
    const avgSpeed = avgSpeedMs(distance, durationSec, methodology.activeTrip.activeDuration);
    const speedMean = meanPointSpeedMs(points);

    // Bounding box
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const bbox = {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };

    // P1-7: план-факт из завершённого TrafficJob
    const route = await computePlanFact(id, distance, durationSec, avgSpeed);
    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    return json(
      {
        sessionId: id,
        pointCount: points.length,
        distance: Math.round(distance),
        duration: Math.round(durationSec),
        // v2.9: из state machine (§4.6/§4.7)
        movingTime: methodology.movingTime,
        idleTime: methodology.idleTime,
        gapTime: methodology.gapTime,
        // v2.9 §10.0: детерминированные хэши маршрута
        routeHash: session.routeHash,
        topologyHash: session.topologyHash,
        avgSpeed: avgSpeed != null ? Math.round(avgSpeed * 10) / 10 : null,
        // P2-13: средняя по точкам — отдельно от KPI AvgSpeed (§4.3)
        speedMeanMs: speedMean != null ? Math.round(speedMean * 10) / 10 : null,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        avgAltitude: prevAlt != null ? Math.round(points.filter((p) => p.altitude != null).reduce((a, p) => a + (p.altitude || 0), 0) / (points.filter((p) => p.altitude != null).length || 1)) : null,
        elevationGain: Math.round(elevationGain),
        elevationLoss: Math.round(elevationLoss),
        bbox,
        startTime: session.startTime,
        endTime: session.endTime,
        methodology,
        route,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Session stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
