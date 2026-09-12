// GET /api/trips/[id] — детальная статистика ПОЕЗДКИ (v2.26.0, ТЗ §10):
// полный конвейер (trip-stats.ts) + фрагменты (записи состава с их
// лёгкими полями для таблицы карточки) + план-факт из поездкового TrafficJob.
// Форма — расширенный TripStatsPayload: карточка «Поездок» и «Аналитика»
// читают одни и те же цифры (один код = одинаковые числа, §8 ТЗ).
//
// DELETE /api/trips/[id] (v2.30.0) — удаление поездки ПОЛЬЗОВАТЕЛЕМ.
// Поездка — производная сущность (канонический состав trip-grouping), поэтому
// удаление = soft-delete ВСЕХ живых записей состава + строки Trip + снятие
// план-джоба. Полный recompute устройства НЕ нужен: поездки по построению
// разделены стоянками ≥ TRIP_SPLIT_SEC — удаление одной цепочки не может
// склеить соседей (их окна/составы не меняются); последующий recompute
// (финализация другой записи) не видит soft-deleted строк и идемпотентен.
// Точки стираются retention-харвестом после GRACE_PERIOD_DAYS — как у
// удаления записи (DELETE /api/sessions/[id]).
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { tripsEnabled } from "@/lib/trip-grouping";
import { loadTripById, computeTripStats } from "@/lib/trip-stats";
import { trackLatency } from "@/lib/latency";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";
import { env } from "@/lib/env";

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

export async function DELETE(
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

    // Живые записи состава (часть могла быть уже удалена поштучно)
    const liveIds: string[] = [];
    let livePoints = 0;
    let liveRecording = trip.status === "recording";
    if (trip.sessionIds.length > 0) {
      const ph = trip.sessionIds.map(() => "?").join(", ");
      const res = await libsql.execute({
        sql: `SELECT id, status, pointCount FROM Session WHERE id IN (${ph}) AND deletedAt IS NULL`,
        args: trip.sessionIds,
      });
      for (const r of res.rows as Record<string, unknown>[]) {
        liveIds.push(String(r.id));
        livePoints += Number(r.pointCount ?? 0);
        if (String(r.status) === "recording") liveRecording = true;
      }
    }

    // Идёт запись: поездка под активным инжестом — точки продолжат писаться
    // в удалённую запись. Отказ 409 с понятным текстом (UI его показывает).
    if (liveRecording) {
      return json({ error: "Поездка ещё записывается — дождитесь окончания записи" }, 409, { "X-Request-Id": requestId });
    }

    const now = new Date().toISOString();
    const stmts: Array<{ sql: string; args: unknown[] }> = [];
    if (liveIds.length > 0) {
      const ph = liveIds.map(() => "?").join(", ");
      stmts.push({
        sql: `UPDATE Session SET deletedAt = ?, status = 'deleted' WHERE id IN (${ph}) AND deletedAt IS NULL`,
        args: [now, ...liveIds],
      });
    }
    // Сама поездка — soft-delete (список /api/trips читает deletedAt IS NULL)
    stmts.push({
      sql: `UPDATE Trip SET deletedAt = ?, status = 'deleted', updatedAt = ? WHERE id = ? AND deletedAt IS NULL`,
      args: [now, now, id],
    });
    // План-джоб поездки: незавершённые снимаются (зеркалит delete-ветку
    // recompute — completed-джобы остаются как история)
    stmts.push({
      sql: `DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')`,
      args: [id],
    });
    // Навигационные ссылки записей на поездку — сброс
    stmts.push({
      sql: `UPDATE Session SET tripId = NULL WHERE tripId = ?`,
      args: [id],
    });
    await libsql.batch(stmts.map((s) => ({ sql: s.sql, args: s.args as never[] })));

    await writeAudit({
      action: "trip.delete",
      targetId: id,
      targetType: "Trip",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "api"), // v2.29.0 (MI-2): честная атрибуция
      sessionId: liveIds[0] ?? null,
      metadata: {
        reason: "user-request",
        deletedSessions: liveIds.length,
        pointCount: livePoints,
        gracePeriodDays: env().GRACE_PERIOD_DAYS,
      },
    });
    inc("trip_delete_total", "Trip deletes (user request)", 1);

    return json(
      { ok: true, deletedSessions: liveIds.length, gracePeriodDays: env().GRACE_PERIOD_DAYS },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Trip delete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
