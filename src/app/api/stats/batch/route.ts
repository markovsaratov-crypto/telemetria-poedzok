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
// Лимиты: ≤50 id за запрос; каждый id — [A-Za-z0-9_-]{1,64}. Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus";
import { computeSessionStats, loadPlanFacts, composeRoute, type SessionStatsMeta } from "@/lib/session-stats";
import { parseBatchIds, batchCacheKey, loadSessionsForBatch } from "@/lib/batch-points";
import { getTtlCache } from "@/lib/ttl-cache";
import { trackLatency } from "@/lib/latency";

const CACHE = getTtlCache<{ stats: Record<string, unknown>[]; missing: string[] }>("stats-batch", 30_000);

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

    // TTL-кэш 30с (сопоставим с клиентским staleTime; живые recording-сессии
    // фронтенд обновляет поштучным роутом каждые 15с — мимо этого кэша)
    const cacheKey = batchCacheKey(ids);
    const cached = CACHE.get(cacheKey);
    if (cached) {
      trackLatency(request);
      return json(cached, 200, { "X-Request-Id": requestId, "X-Cache": "ttl" });
    }

    // ——— меты + точки: чанки параллельно (loadSessionsForBatch) ———
    const sessions = await loadSessionsForBatch(ids);

    // Удалённые — не отдаём (как одиночный роут); их и несуществующие — в missing
    const missing = ids.filter((id) => {
      const e = sessions.get(id);
      return !e || e.deleted;
    });
    const live = ids.map((id) => sessions.get(id)).filter((e): e is NonNullable<typeof e> => !!e && !e.deleted);

    // ——— corpus-калибровка EcoScore — ОДНА на весь батч (кэш 5 мин) ———
    const ecoBaselines = await getCorpusEcoBaselines();

    // ——— 1 запрос TrafficJob: план-факт всех сессий сразу ———
    const facts = await loadPlanFacts(live.map((e) => e.id));

    const stats: Array<Record<string, unknown>> = live.map((entry) => {
      const meta: SessionStatsMeta = {
        id: entry.id,
        startTime: entry.startTime,
        endTime: entry.endTime,
        routeHash: entry.routeHash,
        topologyHash: entry.topologyHash,
      };
      const result = computeSessionStats(meta, entry.points, ecoBaselines);
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

    const payload = { stats, missing };
    CACHE.set(cacheKey, payload);

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch stats computed", { requestId, requested: ids.length, found: live.length, returned: stats.length, missing: missing.length });
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
