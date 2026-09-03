// GET /api/sessions — список с курсорной пагинацией + фильтры (§4.2)
// v2.12.0 (D-1, Q3): к каждому элементу добавляются pointCountActual (фактическое
// число строк GpsPoint — денормализованный pointCount расходится после чисток) и
// endLat/endLon (координаты последней точки — для адресной идентификации поездки
// по названию конечной точки через /api/geocode/reverse).
import { NextRequest } from "next/server";
import { zSessionsQuery } from "@/lib/validation";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const parsed = zSessionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "Invalid query", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const q = parsed.data;

    const where: Record<string, unknown> = {
      deletedAt: null,
    };
    if (q.olderThan) where.endTime = { lt: new Date(q.olderThan) };
    // v2.16.0 (B8): инвертированный фильтр исправлен — параметр «before» теперь
    // действительно означает «до» (было gt: сессии ПОСЛЕ даты; латентный баг —
    // параметром никто не пользовался, но семантика врала)
    if (q.before) where.endTime = { lt: new Date(q.before) };
    if (q.routeId) where.routeId = q.routeId;
    if (q.status) where.status = q.status;
    if (q.deviceId) where.deviceId = { contains: q.deviceId };

    const sessions = await db.session.findMany({
      where,
      orderBy: { startTime: "desc" },
      take: q.limit + 1,
      // v2.18.0: skip:1 УДАЛЁН — keyset-предикат db-обёртки уже исключает курсор;
      // двойной скип выбрасывал первую строку после курсора (см. db.ts)
      ...(q.cursor ? { cursor: { id: q.cursor } } : {}),
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        status: true,
        routeId: true,
        route: { select: { id: true, name: true } },
      },
    });

    const hasMore = sessions.length > q.limit;
    let items = hasMore ? sessions.slice(0, q.limit) : sessions;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    // v2.12.0 (D-1, Q3): фактические счётчики строк GpsPoint и координаты финиша —
    // двумя grouped-запросами по всем id страницы (не N+1).
    if (items.length > 0) {
      try {
        const ids = items.map((s) => String(s.id)); // v2.18.0: типизированный db + InValue[]
        const ph = ids.map(() => "?").join(",");
        const [cntRes, endRes] = await Promise.all([
          libsql.execute({
            sql: `SELECT sessionId, COUNT(*) AS cnt FROM GpsPoint WHERE sessionId IN (${ph}) GROUP BY sessionId`,
            args: ids,
          }),
          libsql.execute({
            sql: `SELECT sessionId, lat, lon FROM (
                    SELECT sessionId, lat, lon,
                           ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY timestamp DESC) AS rn
                    FROM GpsPoint WHERE sessionId IN (${ph})
                  ) WHERE rn = 1`,
            args: ids,
          }),
        ]);
        const cntMap = new Map<string, number>();
        for (const row of cntRes.rows) {
          const r = row as unknown as Record<string, unknown>;
          cntMap.set(String(r.sessionId), Number(r.cnt));
        }
        const endMap = new Map<string, { lat: number; lon: number }>();
        for (const row of endRes.rows) {
          const r = row as unknown as Record<string, unknown>;
          endMap.set(String(r.sessionId), { lat: Number(r.lat), lon: Number(r.lon) });
        }
        items = items.map((s) => {
          const end = endMap.get(String(s.id));
          return {
            ...s,
            pointCountActual: cntMap.get(String(s.id)) ?? 0,
            endLat: end ? end.lat : null,
            endLon: end ? end.lon : null,
          };
        });
      } catch (err) {
        // Деградация без разрушения списка: без адресов/фактических счётчиков
        logger.warn("Sessions list enrichment failed", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return json({ sessions: items, nextCursor }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Sessions list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
