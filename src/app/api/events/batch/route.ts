// GET /api/events/batch?ids=id1,id2,… — v2.19.0: БАТЧ G-G/events для списка
// сессий ОДНИМ запросом (та же проблема N+1, что решал /api/stats/batch в
// v2.17.0 для статов): период-агрегат аналитики качал events каждой записи
// отдельным GET /api/sessions/[id]/events (≤30 запросов + семафор 6).
//
// Ответ: { events: EventsPayload[], missing: string[] } — каждая запись
// ИДЕНТИЧНА одиночному роуту (конвейер src/lib/session-events.ts общий),
// удалённые/несуществующие — в missing. Точки — чанками параллельно
// (src/lib/batch-points.ts), результат — в TTL-кэше 30с.
//
// Лимиты: ≤50 id; формат [A-Za-z0-9_-]{1,64}; Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { parseBatchIds, batchCacheKey, loadSessionsForBatch } from "@/lib/batch-points";
import { computeSessionEvents, type SessionEventsPayload } from "@/lib/session-events";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";

const CACHE = getTtlCache<{ events: SessionEventsPayload[]; missing: string[] }>("events-batch", 30_000);

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const idsRaw = request.nextUrl.searchParams.get("ids") ?? "";
    const parsed = parseBatchIds(idsRaw);
    if (!parsed.ok) {
      return json({ error: "Validation failed", reason: parsed.reason }, 400, { "X-Request-Id": requestId });
    }
    const ids = parsed.ids;

    // TTL-кэш 30с: повторные открытия периода/вкладки и истёкший клиентский
    // staleTime не пересчитывают G-G по 25k точек заново
    const cacheKey = batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    const sessions = await loadSessionsForBatch(ids);
    const missing = ids.filter((id) => {
      const e = sessions.get(id);
      return !e || e.deleted;
    });
    const live = ids.map((id) => sessions.get(id)).filter((e): e is NonNullable<typeof e> => !!e && !e.deleted);

    const events = live.map((entry) =>
      computeSessionEvents(entry.id, entry.deviceId, entry.points)
    );

    const payload = { events, missing };
    CACHE.set(cacheKey, payload);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch events computed", { requestId, requested: ids.length, returned: events.length, missing: missing.length });
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch events error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
