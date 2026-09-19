// GET /api/sessions — список с курсорной пагинацией + фильтры (§4.2)
// v2.12.0 (D-1, Q3): к каждому элементу добавляются pointCountActual (фактическое
// число строк GpsPoint — денормализованный pointCount расходится после чисток) и
// endLat/endLon (координаты последней точки — для адресной идентификации поездки
// по названию конечной точки через /api/geocode/reverse).
// v2.40.5 (квота-N-1, аудит Task 22): enrichment ПЕРЕПИСАН. Прежние два grouped-
// запроса (COUNT(*) GROUP BY sessionId + ROW_NUMBER() OVER (PARTITION BY …))
// читали ВСЕ строки GpsPoint страницы (~20–25 тыс. rows_read на каждый показ
// списка, растёт с данными). Теперь:
//   • pointCountActual — из денормализованного pointCount строки Session (его
//     обновляет инжест на каждом батче; сверка фактики — часовой reconcile);
//     фронт везде и так использует фолбэк `pointCountActual ?? pointCount`;
//   • endLat/endLon — один libsql.batch() из ≤limit индекс-сиков
//     `WHERE sessionId=? ORDER BY timestamp DESC LIMIT 1` (составной индекс
//     GpsPoint(sessionId, timestamp) → ~1 строка на сессию, ≈20 rows_read
//     на страницу вместо десятков тысяч).
import { NextRequest } from "next/server";
import { zSessionsQuery } from "@/lib/validation";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionScopeWhere } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { trackLatency } from "@/lib/latency"; // v2.38.2 · F43: p95 дашбордных роутов
import { D1_BATCH_STMT_CHUNK } from "@/lib/db"; // v2.40.5 · N-1: чанк лимита /batch (400 < 500)

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
      // v2.23.0: изоляция данных — сессии только зоны видимости запрашивающего
      ...sessionScopeWhere(dataScopeFor(auth)),
    };
    if (q.olderThan) where.endTime = { lt: new Date(q.olderThan) };
    // v2.16.0 (B8): инвертированный фильтр исправлен — параметр «before» теперь
    // действительно означает «до» (было gt: сессии ПОСЛЕ даты; латентный баг —
    // параметром никто не пользовался, но семантика врала)
    if (q.before) where.endTime = { lt: new Date(q.before) };
    if (q.routeId) where.routeId = q.routeId;
    if (q.status) where.status = q.status;
    if (q.deviceId) where.deviceId = { contains: q.deviceId };
    // v2.36.0 (кейс 15.09): фильтр микро-фрагментов (блипы 1–3 точки) —
    // денормализованный pointCount обновляется инжестом на каждом батче;
    // для фильтра списка его точности достаточно (фактический счётчик —
    // pointCountActual — остаётся в ответе для отображения).
    if (q.minPoints != null) where.pointCount = { gte: q.minPoints };

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

    // v2.40.5 (квота-N-1): см. шапку файла — индекс-сики вместо full-scan.
    if (items.length > 0) {
      try {
        const ids = items.map((s) => String(s.id)); // v2.18.0: типизированный db + InValue[]
        // Чанки ≤400 стейтментов (лимит /batch шлюза 500) — limit списка ≤200,
        // чанк — на будущее (защита от роста лимита).
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += D1_BATCH_STMT_CHUNK) {
          chunks.push(ids.slice(i, i + D1_BATCH_STMT_CHUNK));
        }
        const endMap = new Map<string, { lat: number; lon: number }>();
        for (const chunk of chunks) {
          // Атомарный batch: один HTTP-раундтрип на чанк, каждый стейтмент —
          // индекс-сик 1 строки (ORDER BY timestamp DESC LIMIT 1 по составному
          // индексу GpsPoint(sessionId, timestamp)).
          const results = await libsql.batch(
            chunk.map((id) => ({
              sql: "SELECT sessionId, lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp DESC LIMIT 1",
              args: [id],
            }))
          );
          for (const res of results) {
            const row = (res.rows as unknown as Record<string, unknown>[])[0];
            if (row) endMap.set(String(row.sessionId), { lat: Number(row.lat), lon: Number(row.lon) });
          }
        }
        items = items.map((s) => {
          const end = endMap.get(String(s.id));
          return {
            ...s,
            // v2.40.5 (N-1): денормализованный счётчик (сверка — часовой
            // reconcile; фронт уже умел фолбэк pointCountActual ?? pointCount)
            pointCountActual: Number(s.pointCount ?? 0),
            endLat: end ? end.lat : null,
            endLon: end ? end.lon : null,
          };
        });
      } catch (err) {
        // Деградация без разрушения списка: без адресов (счётчик остаётся —
        // он больше не требует БД)
        logger.warn("Sessions list enrichment failed", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        items = items.map((s) => ({
          ...s,
          pointCountActual: Number(s.pointCount ?? 0),
          endLat: null,
          endLon: null,
        }));
      }
    }

    trackLatency(request); // v2.38.2 · F43: список сессий в api_latency_p95 (§14.4)
    return json({ sessions: items, nextCursor }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Sessions list error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
