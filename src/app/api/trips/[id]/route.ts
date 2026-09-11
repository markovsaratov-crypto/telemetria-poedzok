// GET /api/trips/[id] — детальная статистика ПОЕЗДКИ (v2.26.0, ТЗ §10):
// полный конвейер (trip-stats.ts) + фрагменты (записи состава с их
// лёгкими полями для таблицы карточки) + план-факт из поездкового TrafficJob.
// Форма — расширенный TripStatsPayload: карточка «Поездок» и «Аналитика»
// читают одни и те же цифры (один код = одинаковые числа, §8 ТЗ).
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { tripsEnabled } from "@/lib/trip-grouping";
import { loadTripById, computeTripStats } from "@/lib/trip-stats";
import { trackLatency } from "@/lib/latency";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    if (!tripsEnabled()) return json({ error: "Trips disabled" }, 503, { "X-Request-Id": requestId });

    const { id } = await params;
    const trip = await loadTripById(id);
    if (!trip) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }
    // v2.23.0: изоляция — чужая поездка неотличима от отсутствующей
    const scope = dataScopeFor(auth);
    const visible =
      scope.mode === "all" ||
      (scope.mode === "unclaimed" && trip.userId == null) ||
      (scope.mode === "own" && trip.userId === scope.userId);
    if (!visible) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });

    const payload = await computeTripStats(trip);
    if (payload == null) {
      return json({ tripId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null }, 200, { "X-Request-Id": requestId });
    }

    // Фрагменты: записи состава (лёгкие поля — таблица в раскрытой карточке)
    let fragments: Array<Record<string, unknown>> = [];
    try {
      if (trip.sessionIds.length > 0) {
        const ph = trip.sessionIds.map(() => "?").join(", ");
        const res = await libsql.execute({
          sql: `SELECT id, deviceId, deviceName, startTime, endTime, pointCount, status
                FROM Session WHERE id IN (${ph}) AND deletedAt IS NULL ORDER BY startTime ASC`,
          args: trip.sessionIds,
        });
        fragments = (res.rows as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          deviceName: r.deviceName == null ? null : String(r.deviceName),
          startTime: String(r.startTime),
          endTime: r.endTime == null ? null : String(r.endTime),
          pointCount: Number(r.pointCount ?? 0),
          status: String(r.status),
        }));
      }
    } catch (err) {
      logger.warn("trip fragments load failed (non-fatal)", {
        requestId, tripId: id, error: err instanceof Error ? err.message : String(err),
      });
    }

    trackLatency(request);
    return json({ ...payload, fragments, sessionIds: trip.sessionIds, tripStatus: trip.status }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Trip stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
