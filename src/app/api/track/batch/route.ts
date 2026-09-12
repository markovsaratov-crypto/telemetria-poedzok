// GET /api/track/batch?ids=id1,id2,… — v2.19.0: БАТЧ треков для списка сессий
// ОДНИМ запросом (та же проблема N+1, что /api/stats/batch в v2.17.0):
// период-агрегат аналитики качал трек каждой записи отдельным
// GET /api/sessions/[id]/track (≤30 запросов + семафор 6).
//
// Ответ: { tracks: TrackPayload[], missing: string[] } — каждая запись
// ИДЕНТИЧНА одиночному роуту (конвейер src/lib/session-track.ts общий),
// удалённые/несуществующие — в missing. Точки — чанками параллельно
// (src/lib/batch-points.ts), результат — в TTL-кэше 30с.
//
// v2.27.0 (ПЕРФ-КЭШ, worklog Task ID 3): закрытые сессии не меняют точек —
// их TrackPayload (points/segments/gaps/harshPoints) достаётся из
// ПЕРСИСТЕНТНОГО кэша Session.trackCache (src/lib/session-cache.ts) одним
// метa-запросом, без выкачки GPS-точек из Мумбаи и нормализации на 0.1 CPU
// (11,2с → ~2с на проде; трек большой мусорной сессии = 61% объёма — теперь
// из строки JSON). Формат дословный — Leaflet-слои не менялись.
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
import { computeSessionTrack } from "@/lib/session-track";
import {
  loadSessionMetasWithCache,
  isSessionCacheFresh,
  parseCachedJson,
  persistSessionCaches,
  type SessionCacheMeta,
} from "@/lib/session-cache";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";

const CACHE = getTtlCache<{ tracks: Record<string, unknown>[]; missing: string[] }>("track-batch", 60_000);

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

    // v2.23.0: изоляция данных — ключ кэша включает зону видимости
    const scope = dataScopeFor(auth);
    const cacheKey = (scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:") + batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    // ——— меты + ПРЕДРАСЧЁТ (trackCache), БЕЗ точек — один IN-запрос ———
    // v2.23.0: чужие сессии не попадают в Map → трактуются как missing
    const metas = await loadSessionMetasWithCache(ids, scope, { track: true });
    const missing = ids.filter((id) => {
      const e = metas.get(id);
      return !e || e.deleted;
    });
    const live = ids.map((id) => metas.get(id)).filter((e): e is SessionCacheMeta => !!e && !e.deleted);

    // ——— протухшие/некэшированные: live-конвейер по их точкам ———
    const staleIds = live.filter((e) => !isSessionCacheFresh(e) || parseCachedJson<Record<string, unknown>>(e.trackCache) == null).map((e) => e.id);
    const staleData = staleIds.length > 0
      ? await loadSessionsForBatch(staleIds, scope)
      : new Map<string, BatchSessionData>();

    const cacheWrites: Array<{ id: string; cachePointCount: number; trackJson?: string }> = [];

    const tracks = live.map((entry) => {
      // v2.27.0: свежий кэш → готовый TrackPayload из JSON (без конвейера)
      const fresh = isSessionCacheFresh(entry) ? parseCachedJson<Record<string, unknown>>(entry.trackCache) : null;
      if (fresh) return fresh;

      const data = staleData.get(entry.id);
      const points = data ? data.points : [];
      const payload = computeSessionTrack(
        { id: entry.id, deviceId: entry.deviceId, startTime: entry.startTime, endTime: entry.endTime, pointCount: entry.pointCount },
        points
      );
      if (data) {
        // write-through: cachePointCount = pointCount меты (см. persistSessionCaches)
        cacheWrites.push({ id: entry.id, cachePointCount: entry.pointCount ?? 0, trackJson: JSON.stringify(payload) });
      }
      return payload as Record<string, unknown>;
    });

    // write-through: перезапись протухших кэшей
    if (cacheWrites.length > 0) {
      await persistSessionCaches(cacheWrites, ["track"]);
    }

    const payload = { tracks, missing };
    CACHE.set(cacheKey, payload);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch track computed", {
      requestId, requested: ids.length, returned: tracks.length,
      missing: missing.length, fromCache: live.length - staleIds.length, computed: staleIds.length,
    });
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch track error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
