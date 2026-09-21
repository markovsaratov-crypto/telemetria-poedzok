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
// v2.41.0 (P0-A, N-8): свежесть поля — ПО PAYLOAD (getCachedPayload):
// строковый cacheVersion пишется и ЧУЖИМИ батч-роутами (stats/batch
// «отстирал» строку v10, trackCache остался от конвейера до N-3 — 2 точки
// Казахстана месяц жили на карте как «свежие»). Теперь payload несёт cacheV
// своего конвейера (cache-versions.ts).
//
// v2.41.0 (P0-C, N-9 + m-22): ?mode=render&maxPoints=400 — серверное
// прореживание (track-render.ts): ≤400 тчк/запись, поля {i,t,lat,lng,v,st}
// (без alt/brg/acc), сегменты пересобраны по оставшимся точкам, разрывы
// перемаплены, «самые резкие» ≤300. Замер Task 28: 6,37 МБ → ~1,4 МБ на
// 50 записей, клиент рендерит ≤4000 точек — 99% байтов шло в мусор.
// Рендер-режим: TTL 300с + SWR (getStale: просроченное отдаётся ещё один
// TTL, ревалидация фоном ОДИН раз на ключ) + ETag/304. Полный режим —
// прежние 60с без SWR (совместимость потребителей полных данных).
//
// Лимиты: ≤50 id; формат [A-Za-z0-9_-]{1,64}; Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json, jsonWithEtag, computeWeakEtag } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { BatchSessionData, batchCacheKey, loadSessionsForBatch, parseBatchIds } from "@/lib/batch-points";
import { computeSessionTrack } from "@/lib/session-track";
import {
  loadSessionMetasWithCache,
  getCachedPayload,
  parseCachedJson,
  persistSessionCaches,
  type SessionCacheMeta,
} from "@/lib/session-cache";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";
import { parseRenderMode, thinTrackForRender, RENDER_MAX_POINTS_DEFAULT } from "@/lib/track-render";

// v2.40.5 (квота-m-13, аудит Task 22): + ETag/304 (паттерн /api/stats §A2).
// Повторные открытия карточек/возвраты по истории гоняли один и тот же JSON
// по сети БЕЗ If-None-Match-экономии: TTL-кэш экономил квоту D1, но не байты/
// парсинг клиента. Кэш хранит {payload, etag}; слабый ETag считается один раз
// при заполнении; jsonWithEtag → 304 (пустое тело) при совпадении.
interface TrackBatchCacheEntry {
  payload: { tracks: Record<string, unknown>[]; missing: string[] };
  etag: string;
}
const CACHE = getTtlCache<TrackBatchCacheEntry>("track-batch", 60_000);
// v2.41.0 (P0-C): рендер-режим — отдельный именованный кэш с TTL 300с
// (прореженный ответ для карты; продлевается SWR до +300с).
const RENDER_CACHE = getTtlCache<TrackBatchCacheEntry>("track-batch-render", 300_000);

inc("batch_render_total", "Batch routes served in render mode (v2.41.0 P0-C)", 0, 'route="track"');
inc("batch_swr_total", "Batch routes served stale-while-revalidate (v2.41.0 P0-C)", 0, 'route="track"');

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

    // v2.41.0 (P0-C): рендер-режим (?mode=render&maxPoints=400)
    const { render, maxPoints } = parseRenderMode(
      request.nextUrl.searchParams.get("mode"),
      request.nextUrl.searchParams.get("maxPoints")
    );

    // v2.23.0: изоляция данных — ключ кэша включает зону видимости
    const scope = dataScopeFor(auth);
    const scopePrefix = scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:";
    const cacheKey = scopePrefix + batchCacheKey(ids) + (render ? `:r${maxPoints}` : "");
    const activeCache = render ? RENDER_CACHE : CACHE;

    const cached = activeCache.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return jsonWithEtag(cached.payload, cached.etag, request, 200, {
        "X-Request-Id": requestId,
        "X-Cache": "ttl",
      });
    }

    // v2.41.0 (P0-C, m-22): SWR — просроченный рендер-ответ отдаём сразу,
    // ревалидация фоном (одиночный полёт внутри getStale)
    if (render) {
      const swr = RENDER_CACHE.getStale(cacheKey, () => {
        void buildAndCache(ids, scope, cacheKey, maxPoints, requestId).catch(() => null);
      });
      if (swr) {
        if (swr.stale) inc("batch_swr_total", "", 1, 'route="track"');
        trackLatency(request);
        return jsonWithEtag(swr.value.payload, swr.value.etag, request, 200, {
          "X-Request-Id": requestId,
          "X-Cache": swr.stale ? "swr" : "ttl",
        });
      }
    }

    // ——— полный путь: меты → персистентный кэш / live-конвейер → кэш ответа ———
    const { payload, etag } = await buildAndCache(ids, scope, cacheKey, render ? maxPoints : 0, requestId);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95
    if (render) inc("batch_render_total", "", 1, 'route="track"');
    return jsonWithEtag(payload, etag, request, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch track error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

/**
 * Сборка ответа + запись в кэш ответа. Единая функция для запроса и фоновой
 * SWR-ревалидации (v2.41.0): payload детерминирован — путь «из кэша» ≡ «live».
 * renderMaxPoints = 0 → полный режим (без прореживания).
 */
async function buildAndCache(
  ids: string[],
  scope: ReturnType<typeof dataScopeFor>,
  cacheKey: string,
  renderMaxPoints: number,
  requestId: string
): Promise<TrackBatchCacheEntry> {
  const render = renderMaxPoints > 0;

  // ——— меты + ПРЕДРАСЧЁТ (trackCache), БЕЗ точек — один IN-запрос ———
  // v2.23.0: чужие сессии не попадают в Map → трактуются как missing
  const metas = await loadSessionMetasWithCache(ids, scope, { track: true });
  const missing = ids.filter((id) => {
    const e = metas.get(id);
    return !e || e.deleted;
  });
  const live = ids.map((id) => metas.get(id)).filter((e): e is SessionCacheMeta => !!e && !e.deleted);

  // ——— протухшие/некэшированные: live-конвейер по их точкам ———
  // v2.41.0 (P0-A, N-8): честность ПО ПОЛЯМ — payload.cacheV конвейера трека
  const staleIds = live
    .filter((e) => getCachedPayload<Record<string, unknown>>(e, "track") == null)
    .map((e) => e.id);
  const staleData = staleIds.length > 0
    ? await loadSessionsForBatch(staleIds, scope)
    : new Map<string, BatchSessionData>();

  const cacheWrites: Array<{ id: string; cachePointCount: number; trackJson?: string }> = [];

  const tracks = live.map((entry) => {
    // v2.41.0 (P0-A): свежий кэш — по штампу конвейера в самом payload
    const fresh = getCachedPayload<Record<string, unknown>>(entry, "track");
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

  // write-through: перезапись протухших кэшей (ПОЛНЫЙ payload — рендер-режим
  // не искажает хранилище истины; прореживание — свойство ответа, не кэша)
  if (cacheWrites.length > 0) {
    await persistSessionCaches(cacheWrites, ["track"]);
  }

  // v2.41.0 (P0-C): рендер-прореживание — ДЕТЕРМИНИРОВАННАЯ пост-транформация
  // одинакова для payload'а из кэша и из live-конвейера
  const outTracks = render
    ? tracks.map((t) => thinTrackForRender(t, renderMaxPoints))
    : tracks;

  const payload = { tracks: outTracks, missing };
  // v2.40.5 (m-13): ETag один раз при заполнении кэша (вход: ключ + JSON)
  const etag = await computeWeakEtag(`${cacheKey}|${JSON.stringify(payload)}`);
  (render ? RENDER_CACHE : CACHE).set(cacheKey, { payload, etag });

  logger.info("batch track computed", {
    requestId, requested: ids.length, returned: tracks.length,
    missing: missing.length, fromCache: live.length - staleIds.length, computed: staleIds.length,
    render, renderMaxPoints: render ? renderMaxPoints : undefined,
  });
  return { payload, etag };
}

// re-export для консистентности импортов тестов (дефолт рендер-потолка)
export { RENDER_MAX_POINTS_DEFAULT };
