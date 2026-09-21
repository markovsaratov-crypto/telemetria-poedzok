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
// v2.41.0 (P0-A, N-8): свежесть поля — ПО PAYLOAD (getCachedPayload):
// строковый cacheVersion пишется и ЧУЖИМИ батч-роутами — payload несёт
// cacheV своего конвейера (cache-versions.ts), «лжесвежесть» исключена.
//
// v2.41.0 (P0-C, N-9 + m-22): ?mode=render — серверные потолки событий
// (track-render.ts thinEventsForRender): maneuvers ≤400, gg.points ≤600,
// harsh/hsc ≤300 (равномерно), summary — ПОЛНЫЙ (счётчики честные).
// Замер Task 28: eventsCache тяжёлой записи 665–677 КБ → десятки КБ;
// 3,50 МБ на 50 записей → ~0,3 МБ. TTL 300с + SWR + ETag/304 (как
// /api/track/batch). Полный режим — прежние 60с.
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
import { computeSessionEvents, type SessionEventsPayload } from "@/lib/session-events";
import {
  loadSessionMetasWithCache,
  getCachedPayload,
  parseCachedJson,
  persistSessionCaches,
  type SessionCacheMeta,
} from "@/lib/session-cache";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";
import { parseRenderMode, thinEventsForRender } from "@/lib/track-render";
import { CACHE_PIPELINE_VERSIONS } from "@/lib/cache-versions";
import {
  loadFinalCalcCandidates,
  readTripCalcRows,
  tripCalcServesEvents,
  upsertTripCalc,
  tripCalcEnabled,
} from "@/lib/trip-calc";

// v2.40.5 (квота-m-13, аудит Task 22): + ETag/304 (паттерн /api/stats §A2 — см.
// идентичный блок в /api/track/batch): кэш хранит {payload, etag}, слабый ETag
// считается один раз при заполнении, jsonWithEtag → 304 при совпадении.
interface EventsBatchCacheEntry {
  payload: { events: SessionEventsPayload[]; missing: string[] };
  etag: string;
}
const CACHE = getTtlCache<EventsBatchCacheEntry>("events-batch", 60_000);
// v2.41.0 (P0-C): рендер-режим — TTL 300с + SWR (прореженные события)
const RENDER_CACHE = getTtlCache<EventsBatchCacheEntry>("events-batch-render", 300_000);

inc("batch_render_total", "Batch routes served in render mode (v2.41.0 P0-C)", 0, 'route="events"');
inc("batch_swr_total", "Batch routes served stale-while-revalidate (v2.41.0 P0-C)", 0, 'route="events"');
inc("tripcalc_serve_total", "Render batches served from TripCalc snapshots (v2.42.0)", 0, 'route="events"');
inc("tripcalc_fallback_total", "Render batch TripCalc candidates served by v2.41.0 fallback (v2.42.0)", 0, 'route="events"');

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

    // v2.41.0 (P0-C): рендер-режим (?mode=render)
    const { render } = parseRenderMode(
      request.nextUrl.searchParams.get("mode"),
      request.nextUrl.searchParams.get("maxPoints")
    );

    // TTL-кэш (закрытая история пересчитывается из персистентного кэша
    // дёшево; активные записи обновляются поштучным роутом мимо батча)
    // v2.23.0: изоляция данных — ключ кэша включает зону видимости
    const scope = dataScopeFor(auth);
    const scopePrefix = scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:";
    const cacheKey = scopePrefix + batchCacheKey(ids) + (render ? ":r" : "");
    const activeCache = render ? RENDER_CACHE : CACHE;

    const cached = activeCache.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return jsonWithEtag(cached.payload, cached.etag, request, 200, {
        "X-Request-Id": requestId,
        "X-Cache": "ttl",
      });
    }

    // v2.41.0 (P0-C, m-22): SWR — просроченный рендер-ответ сразу + ревалидация фоном
    if (render) {
      const swr = RENDER_CACHE.getStale(cacheKey, () => {
        void buildAndCache(ids, scope, cacheKey, render, requestId).catch(() => null);
      });
      if (swr) {
        if (swr.stale) inc("batch_swr_total", "", 1, 'route="events"');
        trackLatency(request);
        return jsonWithEtag(swr.value.payload, swr.value.etag, request, 200, {
          "X-Request-Id": requestId,
          "X-Cache": swr.stale ? "swr" : "ttl",
        });
      }
    }

    const { payload, etag } = await buildAndCache(ids, scope, cacheKey, render, requestId);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95
    if (render) inc("batch_render_total", "", 1, 'route="events"');
    return jsonWithEtag(payload, etag, request, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch events error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

/**
 * Сборка ответа + запись в кэш ответа (единая для запроса и фоновой
 * SWR-ревалидации, v2.41.0).
 *
 * v2.42.0 («Вариант 1», TripCalc): рендер-режим обслуживает финальные
 * записи (> 24 ч) из снапшотов TripCalc.eventsJson (капы thinEventsForRender
 * — ровно форма ответа): eventsCache-колонки (665–677 КБ у тяжёлых записей)
 * не тянутся из D1, прореживание не выполняется. Слой недоступен (403 шлюза
 * до деплоя / сбой) — весь список на пути v2.41.0. Write-through: финальная
 * запись обслужена классически → рендер-форма фиксируется в снапшот.
 */
async function buildAndCache(
  ids: string[],
  scope: ReturnType<typeof dataScopeFor>,
  cacheKey: string,
  render: boolean,
  requestId: string
): Promise<EventsBatchCacheEntry> {
  const nowMs = Date.now();

  // ——— v2.42.0: фаза 0 — финальные записи из TripCalc (только рендер) ———
  const servedByTripCalc = new Map<string, SessionEventsPayload>();
  let classicIds = ids;
  let missing0: string[] | null = null;
  let tripcalcCandidates: Array<{
    id: string; userId: string | null; startTime: string; pointCount: number;
  }> = [];
  if (render && tripCalcEnabled()) {
    const phase0 = await loadFinalCalcCandidates(ids, scope, nowMs);
    if (!phase0.failed) {
      missing0 = phase0.missing;
      const finalIds = phase0.candidates.map((c) => c.id);
      classicIds = ids.filter((id) => !finalIds.includes(id));
      tripcalcCandidates = phase0.candidates.map((c) => ({
        id: c.id, userId: c.userId, startTime: c.startTime, pointCount: c.pointCount ?? 0,
      }));
      if (finalIds.length > 0) {
        const rows = await readTripCalcRows(finalIds, scope, { events: true });
        let served = 0;
        for (const c of phase0.candidates) {
          const row = rows?.get(c.id);
          if (
            tripCalcServesEvents(
              row,
              { endTime: c.endTime, deleted: c.deleted, pointCount: c.pointCount },
              CACHE_PIPELINE_VERSIONS.events,
              nowMs
            )
          ) {
            const parsed = parseCachedJson<SessionEventsPayload>(row!.eventsJson);
            if (parsed) {
              servedByTripCalc.set(c.id, parsed);
              served++;
            }
          }
        }
        if (served > 0) inc("tripcalc_serve_total", "", served, 'route="events"');
        if (served < finalIds.length) {
          inc("tripcalc_fallback_total", "", finalIds.length - served, 'route="events"');
        }
      }
    }
  }

  // ——— меты + ПРЕДРАСЧЁТ (eventsCache), БЕЗ точек — один IN-запрос ———
  // v2.23.0: чужие сессии не попадают в Map → трактуются как missing
  // v2.42.0: только НЕ-обслуженные снапшотами id
  const metas = classicIds.length > 0
    ? await loadSessionMetasWithCache(classicIds, scope, { events: true })
    : new Map<string, SessionCacheMeta>();
  const missing =
    missing0 != null
      ? missing0.filter((id) => {
          const e = metas.get(id);
          return !e || e.deleted;
        })
      : ids.filter((id) => {
          const e = metas.get(id);
          return !e || e.deleted;
        });
  const live = classicIds
    .map((id) => metas.get(id))
    .filter((e): e is SessionCacheMeta => !!e && !e.deleted);

  // ——— протухшие/некэшированные: live-конвейер по их точкам ———
  // v2.41.0 (P0-A, N-8): честность ПО ПОЛЯМ — payload.cacheV конвейера событий
  const staleIds = live
    .filter((e) => getCachedPayload<SessionEventsPayload>(e, "events") == null)
    .map((e) => e.id);
  const staleData = staleIds.length > 0
    ? await loadSessionsForBatch(staleIds, scope)
    : new Map<string, BatchSessionData>();

  const cacheWrites: Array<{ id: string; cachePointCount: number; eventsJson?: string }> = [];

  const classicEvents = live.map((entry) => {
    // v2.41.0 (P0-A): свежий кэш — по штампу конвейера в самом payload
    const fresh = getCachedPayload<SessionEventsPayload>(entry, "events");
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

  // write-through: перезапись протухших кэшей (ПОЛНЫЙ payload — прореживание
  // рендера не попадает в хранилище истины)
  if (cacheWrites.length > 0) {
    await persistSessionCaches(cacheWrites, ["events"]);
  }

  // v2.41.0 (P0-C): рендер-потолки (summary — без изменений: счётчики честные)
  // v2.42.0: для classicIds; снапшотные payload'ы уже в рендер-форме
  const outClassic = render
    ? classicEvents.map((e) => thinEventsForRender(e as unknown as Record<string, unknown>) as unknown as SessionEventsPayload)
    : classicEvents;

  // сборка в ПОРЯДКЕ ids (семантика v2.41.0)
  const byId = new Map<string, SessionEventsPayload>();
  live.forEach((e, i) => byId.set(e.id, outClassic[i]));
  for (const [id, p] of servedByTripCalc) byId.set(id, p);
  const outEvents = ids.map((id) => byId.get(id)).filter((p): p is SessionEventsPayload => !!p);

  // ——— v2.42.0: write-through снапшотов финальных записей (рендер-форма) ———
  if (render && tripcalcCandidates.length > 0) {
    const writes = tripcalcCandidates
      .filter((c) => !servedByTripCalc.has(c.id))
      .map((c) => {
        const thin = byId.get(c.id);
        if (!thin) return null;
        return {
          sessionId: c.id,
          userId: c.userId,
          startTime: c.startTime,
          pointCount: c.pointCount,
          eventsJson: JSON.stringify(thin),
        };
      })
      .filter((w): w is NonNullable<typeof w> => w != null);
    if (writes.length > 0) {
      await upsertTripCalc(writes);
    }
  }

  const payload = { events: outEvents, missing };
  // v2.40.5 (m-13): ETag один раз при заполнении кэша
  const etag = await computeWeakEtag(`${cacheKey}|${JSON.stringify(payload)}`);
  (render ? RENDER_CACHE : CACHE).set(cacheKey, { payload, etag });

  logger.info("batch events computed", {
    requestId, requested: ids.length, returned: outEvents.length,
    missing: missing.length, fromCache: live.length - staleIds.length, computed: staleIds.length,
    render, tripcalcServed: servedByTripCalc.size,
  });
  return { payload, etag };
}
