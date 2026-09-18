// GET /api/trips/batch?ids=… — БАТЧ-СТАТЫ ПОЕЗДОК (v2.26.0, ТЗ §10): полная
// статистика списка поездок ОДНИМ запросом — зеркально /api/stats/batch
// (записи): тот же конвейер trip-stats.ts → computeSessionStats на
// конкатенированном потоке, TTL-кэш 30с, ключ включает зону видимости (§scope).
// Формат TripStatsPayload идентичен GET /api/trips/[id] — кэш react-query
// сеется per-trip, карточки «Поездок» рендерятся без поштучных запросов.
//
// v2.38.0: ids обрабатываются параллельными чанками по 8 (быстрый путь —
// 2 запроса на поездку к D1-шлюзу; последовательные раундтрипы 15 поездок
// стоили 2-3 с). Лимиты: ≤50 id; каждый id — [A-Za-z0-9_-]{1,64}. Read-скоп (proxy.ts).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json, jsonWithEtag, computeWeakEtag } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus";
import { parseBatchIds, batchCacheKey } from "@/lib/batch-points";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";
import { tripsEnabled } from "@/lib/trip-grouping";
import { loadTripById, computeTripStats, type TripStatsPayload } from "@/lib/trip-stats";

// v2.39.0 (§A2): кэш хранит {body, etag} — слабый ETag считается один раз при
// заполнении TTL-кэша; ответы отдаются через jsonWithEtag (If-None-Match → 304,
// заголовки ETag + Cache-Control: private, max-age=30, stale-while-revalidate=60).
interface TripsBatchCacheEntry {
  body: { stats: Record<string, unknown>[]; missing: string[] };
  etag: string;
}
const CACHE = getTtlCache<TripsBatchCacheEntry>("trips-stats-batch", 30_000);

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    if (!tripsEnabled()) {
      return json({ stats: [], missing: [], disabled: true }, 200, { "X-Request-Id": requestId });
    }

    const idsRaw = request.nextUrl.searchParams.get("ids") ?? "";
    const parsed = parseBatchIds(idsRaw);
    if (!parsed.ok) {
      return json({ error: "Validation failed", reason: parsed.reason }, 400, { "X-Request-Id": requestId });
    }
    const ids = parsed.ids;

    // TTL-кэш 30с; ключ — зона видимости (v2.23.0 изоляция данных)
    const scope = dataScopeFor(auth);
    const cacheKey = (scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:") + batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      // v2.39.0 (§A2): 304 при совпадении If-None-Match — повторный опрос вкладки
      // «Поездки» почти бесплатен (квота D1 не тратится на пересчёт)
      return jsonWithEtag(cached.body, cached.etag, request, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    const baselines = await getCorpusEcoBaselines(); // ОДНА corpus-калибровка на батч (§7.3)
    const stats: Record<string, unknown>[] = [];
    const missing: string[] = [];

    // v2.38.0: параллельные чанки по 8 (порядок ответа сохранён — map по ids)
    const computeOne = async (id: string): Promise<Record<string, unknown> | null> => {
      const trip = await loadTripById(id);
      // Изоляция: чужая поездка неотличима от отсутствующей
      const visible =
        trip != null &&
        (scope.mode === "all" || (scope.mode === "unclaimed" && trip.userId == null) || (scope.mode === "own" && trip.userId === scope.userId));
      if (!trip || !visible) return null;
      const payload = await computeTripStats(trip, baselines);
      if (payload == null) return null;
      return payload as unknown as Record<string, unknown>;
    };
    const CHUNK = 8;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(computeOne));
      results.forEach((r, idx) => {
        if (r == null) missing.push(chunk[idx]);
        else stats.push(r);
      });
    }

    const body = { stats, missing };
    // v2.39.0 (§A2): хэш — скоуп+ids+JSON, считается при заполнении кэша один раз
    const etag = await computeWeakEtag(`${cacheKey}|${JSON.stringify(body)}`);
    CACHE.set(cacheKey, { body, etag });
    trackLatency(request);
    return jsonWithEtag(body, etag, request, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Trips batch error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export type { TripStatsPayload };
