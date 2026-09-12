// GET /api/stats/batch?ids=id1,d2,… — БАТЧ-СТАТС (запрос владельца 03.09:
// «сделай батч статс эндпойнт»): полная статистика списка сессий ОДНИМ запросом.
//
// Проблема, которую решает: вкладки «Поездки»/«Аналитика» грузили статы каждой
// записи отдельным GET /api/sessions/[id]/stats (25 записей = 25 запросов;
// с семафором 6-параллельных и медленным Turso-HTTP — 40–60 с полной загрузки,
// v2.14.x). Здесь: 1 запрос TrafficJob (IN-list), 1 corpus-калибровка EcoScore —
// и тот же конвейер session-stats.ts, что и у одиночного роута → цифры
// совпадают дословно (см. QA Task 14).
//
// Ответ: { stats: SessionStats[], missing: string[] } — запись без точек даёт
// пустую форму (как одиночный роут), удалённые/несуществующие — в missing.
// Формат SessionStats — идентичен /api/sessions/[id]/stats, включая
// speedProfile/методологию/план-факт: посеянный в кэш ответ потребляется
// всеми существующими компонентами без адаптации.
//
// v2.19.0: (а) точки — НЕ одним LEFT JOIN, а ЧАНКАМИ ПАРАЛЛЕЛЬНО
// (src/lib/batch-points.ts; холодный батч ~10–22 с сжимается до времени
// самого медленного чанка); (б) TTL-кэш 30с на ответ — повторные загрузки
// между вкладками/устройствами не пересчитывают конвейер.
//
// v2.27.0 (ПЕРФ-КЭШ, worklog Task ID 3): ответ собирается из ПЕРСИСТЕНТНОГО
// кэша предрасчёта Session.statsCache (src/lib/session-cache.ts) — закрытые
// сессии не меняют точек, их SessionStatsResult достаётся одним метa-запросом
// без конвейера по GPS-точкам (28с → ~1с на проде). Протухший/отсутствующий
// кэш (recording-сессия, первая загрузка после релиза) — прежний live-расчёт
// с write-through перезаписью кэша. route (план-факт) — как и раньше, из
// живого TrafficJob: воркер завершает джоб ПОСЛЕ финализации, кэшировать
// его нельзя. TTL поднят 30с → 60с: пересчёт по валидному кэшу дешёв,
// свежесть закрытой истории не страдает.
//
// Лимиты: ≤50 id за запрос; каждый id — [A-Za-z0-9_-]{1,64}. Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus";
import { computeSessionStats, loadPlanFacts, composeRoute, type SessionStatsMeta, type SessionStatsResult } from "@/lib/session-stats";
import { BatchSessionData, batchCacheKey, loadSessionsForBatch, parseBatchIds } from "@/lib/batch-points";
import {
  loadSessionMetasWithCache,
  isSessionCacheFresh,
  parseCachedJson,
  persistSessionCaches,
  type SessionCacheMeta,
} from "@/lib/session-cache";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";

const CACHE = getTtlCache<{ stats: Record<string, unknown>[]; missing: string[] }>("stats-batch", 60_000);

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // ——— разбор ?ids= (единые правила всех батч-роутов) ———
    const idsRaw = request.nextUrl.searchParams.get("ids") ?? "";
    const parsed = parseBatchIds(idsRaw);
    if (!parsed.ok) {
      return json({ error: "Validation failed", reason: parsed.reason }, 400, { "X-Request-Id": requestId });
    }
    const ids = parsed.ids;

    // TTL-кэш 60с (живые recording-сессии фронтенд обновляет поштучным роутом
    // каждые 15с — мимо этого кэша; закрытая история пересчитывается из
    // персистентного кэша дёшево — задержка в 60с её не искажает)
    // v2.23.0: изоляция данных — ключ кэша включает зону видимости
    const scope = dataScopeFor(auth);
    const cacheKey = (scope.mode === "own" ? `own:${scope.userId}:` : scope.mode === "unclaimed" ? "unclaimed:" : "all:") + batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    // ——— меты + ПРЕДРАСЧЁТ (statsCache), БЕЗ точек — один IN-запрос ———
    // v2.23.0: чужие сессии не попадают в Map → трактуются как missing
    const metas = await loadSessionMetasWithCache(ids, scope, { stats: true });

    // Удалённые — не отдаём (как одиночный роут); их и несуществующие — в missing
    const missing = ids.filter((id) => {
      const e = metas.get(id);
      return !e || e.deleted;
    });
    const live = ids.map((id) => metas.get(id)).filter((e): e is SessionCacheMeta => !!e && !e.deleted);

    // ——— протухшие/некэшированные: live-конвейер по их точкам ———
    const staleIds = live.filter((e) => !isSessionCacheFresh(e) || parseCachedJson<SessionStatsResult>(e.statsCache) == null).map((e) => e.id);
    const staleData = staleIds.length > 0
      ? await loadSessionsForBatch(staleIds, scope)
      : new Map<string, BatchSessionData>();

    // ——— corpus-калибровка EcoScore — ОДНА на весь батч (кэш 5 мин);
    // нужна только если есть live-пересчёт ———
    const ecoBaselines = staleIds.length > 0 ? await getCorpusEcoBaselines() : undefined;

    // ——— 1 запрос TrafficJob: план-факт всех сессий сразу (живой, НЕ из кэша:
    // воркер дорабатывает джобы после финализации) ———
    const facts = await loadPlanFacts(live.map((e) => e.id));

    const cacheWrites: Array<{ id: string; cachePointCount: number; statsJson?: string }> = [];

    const stats: Array<Record<string, unknown>> = live.map((entry) => {
      // v2.27.0: свежий кэш → готовый SessionStatsResult из JSON (без конвейера)
      const fresh = isSessionCacheFresh(entry) ? parseCachedJson<SessionStatsResult>(entry.statsCache) : null;
      if (fresh) {
        if (fresh.kind === "empty") {
          return fresh.payload as unknown as Record<string, unknown>;
        }
        const route = composeRoute(
          facts.get(entry.id),
          fresh.activeDistanceM,
          fresh.actualDurationSec,
          fresh.avgSpeedRawMs
        );
        return { ...fresh.payload, route };
      }

      // ——— live-расчёт (протухший кэш / первый раз): тот же конвейер ———
      const data = staleData.get(entry.id);
      const points = data ? data.points : [];
      const meta: SessionStatsMeta = {
        id: entry.id,
        startTime: entry.startTime,
        endTime: entry.endTime,
        routeHash: entry.routeHash,
        topologyHash: entry.topologyHash,
      };
      const result = computeSessionStats(meta, points, ecoBaselines);
      // write-through: cachePointCount = pointCount меты НА МОМЕНТ SELECT
      // (инжест инкрементит мету → новые точки инвалидируют кэш; гонка и
      // исторические расхождения — см. persistSessionCaches)
      if (data) {
        cacheWrites.push({ id: entry.id, cachePointCount: entry.pointCount ?? 0, statsJson: JSON.stringify(result) });
      }
      if (result.kind === "empty") {
        // форма прежнего early-return одиночного роута (без route-блока)
        return result.payload as unknown as Record<string, unknown>;
      }
      const route = composeRoute(
        facts.get(entry.id),
        result.activeDistanceM,
        result.actualDurationSec,
        result.avgSpeedRawMs
      );
      return { ...result.payload, route };
    });

    // write-through: перезапись протухших кэшей (чанки параллельно, не роняет
    // ответ при сбое — warn внутри persistSessionCaches)
    if (cacheWrites.length > 0) {
      await persistSessionCaches(cacheWrites, ["stats"]);
    }

    const payload = { stats, missing };
    CACHE.set(cacheKey, payload);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch stats computed", {
      requestId, requested: ids.length, found: live.length, returned: stats.length,
      missing: missing.length, fromCache: live.length - staleIds.length, computed: staleIds.length,
    });
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
