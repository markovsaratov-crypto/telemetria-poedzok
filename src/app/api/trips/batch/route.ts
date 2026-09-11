// GET /api/trips/batch?ids=… — БАТЧ-СТАТЫ ПОЕЗДОК (v2.26.0, ТЗ §10): полная
// статистика списка поездок ОДНИМ запросом — зеркально /api/stats/batch
// (записи): тот же конвейер trip-stats.ts → computeSessionStats на
// конкатенированном потоке, TTL-кэш 30с, ключ включает зону видимости (§scope).
// Формат TripStatsPayload идентичен GET /api/trips/[id] — кэш react-query
// сеется per-trip, карточки «Поездок» рендерятся без поштучных запросов.
//
// Лимиты: ≤50 id; каждый id — [A-Za-z0-9_-]{1,64}. Read-скоп (proxy.ts).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus";
import { parseBatchIds, batchCacheKey } from "@/lib/batch-points";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";
import { tripsEnabled } from "@/lib/trip-grouping";
import { loadTripById, computeTripStats, type TripStatsPayload } from "@/lib/trip-stats";

const CACHE = getTtlCache<{ stats: Record<string, unknown>[]; missing: string[] }>("trips-stats-batch", 30_000);

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
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    const baselines = await getCorpusEcoBaselines(); // ОДНА corpus-калибровка на батч (§7.3)
    const stats: Record<string, unknown>[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const trip = await loadTripById(id);
      // Изоляция: чужая поездка неотличима от отсутствующей
      const visible =
        trip != null &&
        (scope.mode === "all" || (scope.mode === "unclaimed" && trip.userId == null) || (scope.mode === "own" && trip.userId === scope.userId));
      if (!trip || !visible) {
        missing.push(id);
        continue;
      }
      const payload = await computeTripStats(trip, baselines);
      if (payload == null) {
        missing.push(id);
        continue;
      }
      stats.push(payload as unknown as Record<string, unknown>);
    }

    const body = { stats, missing };
    CACHE.set(cacheKey, body);
    trackLatency(request);
    return json(body, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Trips batch error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export type { TripStatsPayload };
