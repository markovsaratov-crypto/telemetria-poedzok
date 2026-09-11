// GET /api/trips — список ПОЕЗДОК (v2.26.0, ТЗ «Поездка не рвётся», §10).
// Поездка = каноническая сущность trip-grouping.ts (интервал/стоянка < 900 c);
// записи — транспортные фрагменты состава (sessionIds).
//
// Лёгкий список: кэш-поля метрик из Trip.* (null = «не посчитано» — карточки
// добирают полные статы через GET /api/trips/batch, как записи через
// /api/stats/batch). Cookie или Bearer; read-скоп rate-limit (proxy.ts).
// TRIP_ENABLED=false → пустой список (expand-фаза §13 ТЗ: UI на записях, как v2.25).
import { NextRequest } from "next/server";
import { z } from "zod";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { tripsEnabled } from "@/lib/trip-grouping";
import { mapTripRow } from "@/lib/trip-stats";
import { trackLatency } from "@/lib/latency";

const zTripsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  deviceId: z.string().max(64).optional(),
});

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    if (!tripsEnabled()) {
      return json({ trips: [], disabled: true }, 200, { "X-Request-Id": requestId });
    }

    const url = new URL(request.url);
    const parsed = zTripsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "Invalid query", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const q = parsed.data;

    // v2.23.0-модель владения: userId поездки = userId её записей
    const scope = dataScopeFor(auth);
    let scopeSql = "";
    const scopeArgs: unknown[] = [];
    if (scope.mode === "own") {
      scopeSql = " AND userId = ?";
      scopeArgs.push(scope.userId);
    } else if (scope.mode === "unclaimed") {
      scopeSql = " AND userId IS NULL";
    }

    const res = await libsql.execute({
      sql: `SELECT * FROM Trip
            WHERE deletedAt IS NULL${q.deviceId ? " AND deviceId = ?" : ""}${scopeSql}
            ORDER BY spanStart DESC
            LIMIT ?`,
      args: [...(q.deviceId ? [q.deviceId] : []), ...scopeArgs, q.limit] as never[],
    });

    const trips = (res.rows as Record<string, unknown>[]).map(mapTripRow).map((t) => ({
      id: t.id,
      deviceId: t.deviceId,
      status: t.status,
      startTime: t.startTime,
      endTime: t.endTime,
      spanStart: t.spanStart,
      spanEnd: t.spanEnd,
      startLat: t.startLat,
      startLon: t.startLon,
      endLat: t.endLat,
      endLon: t.endLon,
      sessionCount: t.sessionCount,
      sessionIds: t.sessionIds,
      interFragmentGapSec: t.interFragmentGapSec,
      // кэш-агрегаты карточки (null = ещё не посчитано)
      distanceM: t.distanceM,
      activeDurationSec: t.activeDurationSec,
      durationSec: t.spanEnd && t.spanStart
        ? Math.max(0, (new Date(t.spanEnd).getTime() - new Date(t.spanStart).getTime()) / 1000)
        : null,
      pointCountActual: t.pointCountActual,
      maxSpeedMs: t.maxSpeedMs,
      ecoScore: t.ecoScore,
      planComparable: t.planComparable,
      planDeviationSec:
        t.planDurationSec != null && t.activeDurationSec != null
          ? Math.round(t.activeDurationSec - t.planDurationSec)
          : null,
    }));

    trackLatency(request);
    return json({ trips }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Trips list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
