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
// v2.27.0 (ПЕРФ-КЭШ, worklog Task ID 3): закрытые сессии не меняют точек —
// их EventsPayload достаётся из ПЕРСИСТЕНТНОГО кэша Session.eventsCache
// (src/lib/session-cache.ts) одним метa-запросом, без конвейера по точкам
// (28,9с → ~1–2с на проде; maneuvers/gg закешированы в исходном виде —
// фронтовой агрегатор v4-hooks их сэмплит на клиенте, формат не менялся).
// Протухший кэш — live-расчёт + write-through. TTL 30с → 60с.
//
// Лимиты: ≤50 id; формат [A-Za-z0-9_-]{1,64}; Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { BatchSessionData, batchCacheKey, loadSessionsForBatch, parseBatchIds } from "@/lib/batch-points";
import { computeSessionEvents, type SessionEventsPayload } from "@/lib/session-events";
import {
  loadSessionMetasWithCache,
  isSessionCacheFresh,
  parseCachedJson,
  persistSessionCaches,
  type SessionCacheMeta,
} from "@/lib/session-cache";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";

const CACHE = getTtlCache<{ events: SessionEventsPayload[]; missing: string[] }>("events-batch", 60_000);

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

    // TTL-кэш 60с (закрытая история пересчитывается из персистентного кэша
    // дёшево; активные записи обновляются поштучным роутом мимо батча)
    // v2.23.0: изоляция данных — ключ кэша включает зону видимости
    const scope = dataScopeFor(auth);
    const cacheKey = (scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:") + batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    // ——— меты + ПРЕДРАСЧЁТ (eventsCache), БЕЗ точек — один IN-запрос ———
    // v2.23.0: чужие сессии не попадают в Map → трактуются как missing
    const metas = await loadSessionMetasWithCache(ids, scope, { events: true });
    const missing = ids.filter((id) => {
      const e = metas.get(id);
      return !e || e.deleted;
    });
    const live = ids.map((id) => metas.get(id)).filter((e): e is SessionCacheMeta => !!e && !e.deleted);

    // ——— протухшие/некэшированные: live-конвейер по их точкам ———
    const staleIds = live.filter((e) => !isSessionCacheFresh(e) || parseCachedJson<SessionEventsPayload>(e.eventsCache) == null).map((e) => e.id);
    const staleData = staleIds.length > 0
      ? await loadSessionsForBatch(staleIds, scope)
      : new Map<string, BatchSessionData>();

    const cacheWrites: Array<{ id: string; cachePointCount: number; eventsJson?: string }> = [];

    const events = live.map((entry) => {
      // v2.27.0: свежий кэш → готовый EventsPayload из JSON (без конвейера)
      const fresh = isSessionCacheFresh(entry) ? parseCachedJson<SessionEventsPayload>(entry.eventsCache) : null;
      if (fresh) return fresh;

      const data = staleData.get(entry.id);
      const points = data ? data.points : [];
      const payload = computeSessionEvents(entry.id, entry.deviceId, points);
      // write-through: cachePointCount = pointCount меты (см. persistSessionCaches)
      if (data) {
        cacheWrites.push({ id: entry.id, cachePointCount: entry.pointCount ?? 0, eventsJson: JSON.stringify(payload) });
      }
      return payload;
    });

    // write-through: перезапись протухших кэшей
    if (cacheWrites.length > 0) {
      await persistSessionCaches(cacheWrites, ["events"]);
    }

    const payload = { events, missing };
    CACHE.set(cacheKey, payload);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch events computed", {
      requestId, requested: ids.length, returned: events.length,
      missing: missing.length, fromCache: live.length - staleIds.length, computed: staleIds.length,
    });
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch events error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
