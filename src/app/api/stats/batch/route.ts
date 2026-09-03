// GET /api/stats/batch?ids=id1,id2,… — БАТЧ-СТАТС (запрос владельца 03.09:
// «сделай батч статс эндпойнт»): полная статистика списка сессий ОДНИМ запросом.
//
// Проблема, которую решает: вкладки «Поездки»/«Аналитика» грузили статы каждой
// записи отдельным GET /api/sessions/[id]/stats (25 записей = 25 запросов;
// с семафором 6-параллельных и медленным Turso-HTTP — 40–60 с полной загрузки,
// v2.14.x). Здесь: 1 запрос точек (один JOIN IN-list), 1 запрос TrafficJob
// (IN-list), 1 corpus-калибровка EcoScore — и тот же конвейер session-stats.ts,
// что и у одиночного роута → цифры совпадают дословно (см. QA Task 14).
//
// Ответ: { stats: SessionStats[], missing: string[] } — запись без точек даёт
// пустую форму (как одиночный роут), удалённые/несуществующие — в missing.
// Формат SessionStats — идентичен /api/sessions/[id]/stats, включая
// speedProfile/методологию/план-факт: посеянный в кэш ответ потребляется
// всеми существующими компонентами без адаптации.
//
// Лимиты: ≤50 id за запрос; каждый id — [A-Za-z0-9_-]{1,64}. Cookie или Bearer.
// Read-скоп rate-limit (proxy.ts, 240/мин).
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus";
import { computeSessionStats, loadPlanFacts, composeRoute, type SessionStatsMeta } from "@/lib/session-stats";
import { trackLatency } from "@/lib/latency";

const MAX_IDS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface GroupedSession {
  deleted: boolean;
  meta: SessionStatsMeta;
  points: Array<{
    lat: number;
    lon: number;
    speed: number | null;
    altitude: number | null;
    accuracy: number | null;
    bearing: number | null;
    timestamp: number;
  }>;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // ——— разбор ?ids= ———
    const idsRaw = request.nextUrl.searchParams.get("ids") ?? "";
    // URL-decoding уже выполнен searchParams; запятая — разделитель
    const ids = [...new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) {
      return json({ error: "Validation failed", reason: "ids required (comma-separated session ids)" }, 400, { "X-Request-Id": requestId });
    }
    if (ids.length > MAX_IDS) {
      return json({ error: "Validation failed", reason: `max ${MAX_IDS} ids per request` }, 400, { "X-Request-Id": requestId });
    }
    if (ids.some((id) => !ID_RE.test(id))) {
      return json({ error: "Validation failed", reason: "invalid id format" }, 400, { "X-Request-Id": requestId });
    }

    // ——— 1 запрос: сессии + точки (LEFT JOIN — сессии без точек тоже попадают) ———
    const placeholders = ids.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT s.id AS sid, s.startTime AS startTime, s.endTime AS endTime,
                   s.deletedAt AS deletedAt, s.routeHash AS routeHash, s.topologyHash AS topologyHash,
                   g.lat AS lat, g.lon AS lon, g.speed AS speed, g.altitude AS altitude,
                   g.accuracy AS accuracy, g.bearing AS bearing, g.timestamp AS ts
            FROM Session s LEFT JOIN GpsPoint g ON g.sessionId = s.id
            WHERE s.id IN (${placeholders})
            ORDER BY g.timestamp ASC`,
      args: ids,
    });

    // Группировка строк по сессиям (хронология внутри — из ORDER BY)
    const grouped = new Map<string, GroupedSession>();
    for (const row of res.rows as Record<string, unknown>[]) {
      const sid = String(row.sid);
      let entry = grouped.get(sid);
      if (!entry) {
        entry = {
          deleted: row.deletedAt != null,
          meta: {
            id: sid,
            startTime: String(row.startTime),
            endTime: row.endTime == null ? null : String(row.endTime),
            routeHash: row.routeHash == null ? null : String(row.routeHash),
            topologyHash: row.topologyHash == null ? null : String(row.topologyHash),
          },
          points: [],
        };
        grouped.set(sid, entry);
      }
      // LEFT JOIN: сессия без точек даёт одну строку с NULL-ами в полях g.*
      if (row.lat == null || row.ts == null) continue;
      entry.points.push({
        lat: Number(row.lat),
        lon: Number(row.lon),
        speed: row.speed == null ? null : Number(row.speed),
        altitude: row.altitude == null ? null : Number(row.altitude),
        accuracy: row.accuracy == null ? null : Number(row.accuracy),
        bearing: row.bearing == null ? null : Number(row.bearing),
        timestamp: Number(row.ts),
      });
    }

    // Удалённые — не отдаём (как одиночный роут); их и несуществующие — в missing
    const missing = ids.filter((id) => {
      const e = grouped.get(id);
      return !e || e.deleted;
    });
    const live = [...grouped.values()].filter((e) => !e.deleted);

    // ——— corpus-калибровка EcoScore — ОДНА на весь батч (кэш 5 мин) ———
    const ecoBaselines = await getCorpusEcoBaselines();

    // ——— 1 запрос TrafficJob: план-факт всех сессий сразу ———
    const facts = await loadPlanFacts(live.map((e) => e.meta.id));

    const stats: Array<Record<string, unknown>> = live.map((entry) => {
      const result = computeSessionStats(entry.meta, entry.points, ecoBaselines);
      if (result.kind === "empty") {
        // форма прежнего early-return одиночного роута (без route-блока)
        return result.payload as unknown as Record<string, unknown>;
      }
      const route = composeRoute(
        facts.get(entry.meta.id),
        result.activeDistanceM,
        result.actualDurationSec,
        result.avgSpeedRawMs
      );
      return { ...result.payload, route };
    });

    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    logger.info("batch stats computed", { requestId, requested: ids.length, found: live.length, returned: stats.length, missing: missing.length });
    return json({ stats, missing }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Batch stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
