// GET /api/stats/speed-record — рекорд скорости за всё время (§4.5 MaxSpeedAllTime).
// v2.13.0 (Ф1): KPI «Рекорд скорости» раньше был захардкожен «—» — метрика
// не считалась ни одним эндпоинтом. Здесь: максимум по всем живым сессиям
// тем же анти-джиттер конвейером, что и §4.4 MaxSpeed (normalizeSessionSpeeds
// из kpi.ts — AUDIT B-4 + пересчёт по геометрии для битых полей speed).
// Кэш в памяти 5 минут (по образцу corpus-baselines). Данные — одним JOIN-запросом
// через libsql (кастомный db.ts не exposes gpsPoint.findMany).
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionScopeSql } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { maxSpeedMs, normalizeSessionSpeeds } from "@/lib/kpi";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface SpeedRecordValue {
  maxSpeedAllTimeKmh: number | null;
  sessionId: string | null;
  date: string | null; // startTime сессии-рекордсмена (ISO)
}

// v2.23.0: кэш ПО РЕЖИМУ СКОУПА — общий кэш лил бы чужой рекорд другому юзеру
const scopeCache = new Map<string, { value: SpeedRecordValue; ts: number }>();

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const scope = dataScopeFor(auth);
    const cacheKey = scope.mode === "own" ? `own:${scope.userId}` : scope.mode;
    const cached = scopeCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return json(cached.value, 200, { "X-Request-Id": requestId, "Cache-Control": "private, max-age=300" });
    }

    // Живые сессии с GPS-точками одним JOIN (хронологический порядок).
    // v2.23.0: изоляция данных — рекорд считается по своей зоне видимости
    const sc = sessionScopeSql(scope, "s");
    const res = await libsql.execute({
      sql: `SELECT s.id AS sid, s.startTime AS startTime, g.lat, g.lon, g.timestamp, g.speed, g.bearing, g.accuracy
            FROM Session s JOIN GpsPoint g ON g.sessionId = s.id
            WHERE s.deletedAt IS NULL${sc.clause}
            ORDER BY s.startTime ASC, g.timestamp ASC`,
      args: sc.args as never[],
    });

    // Группировка точек по сессиям (строки уже в хронологическом порядке).
    const bySession = new Map<string, { startTime: string; points: Array<{ lat: number; lon: number; timestamp: number; speed: number | null; bearing: number | null; accuracy: number | null; altitude: null }> }>();
    for (const row of res.rows as Record<string, unknown>[]) {
      const sid = String(row.sid);
      let entry = bySession.get(sid);
      if (!entry) {
        entry = { startTime: String(row.startTime), points: [] };
        bySession.set(sid, entry);
      }
      entry.points.push({
        lat: Number(row.lat),
        lon: Number(row.lon),
        timestamp: Number(row.timestamp),
        speed: row.speed == null ? null : Number(row.speed),
        bearing: row.bearing == null ? null : Number(row.bearing),
        accuracy: row.accuracy == null ? null : Number(row.accuracy),
        altitude: null,
      });
    }

    let bestMs: number | null = null;
    let bestSession: { id: string; startTime: string } | null = null;

    for (const [sid, { startTime, points }] of bySession) {
      if (points.length < 5) continue;
      const norm = normalizeSessionSpeeds(points);
      const mx = maxSpeedMs(norm);
      if (mx != null && (bestMs == null || mx > bestMs)) {
        bestMs = mx;
        bestSession = { id: sid, startTime };
      }
    }
    void db; // db не нужен — прямой libsql-запрос выше

    const value: SpeedRecordValue = bestMs != null && bestSession
      ? {
          maxSpeedAllTimeKmh: Math.round(bestMs * 3.6 * 10) / 10,
          sessionId: bestSession.id,
          date: bestSession.startTime,
        }
      : { maxSpeedAllTimeKmh: null, sessionId: null, date: null };

    scopeCache.set(cacheKey, { value, ts: Date.now() });
    return json(value, 200, { "X-Request-Id": requestId, "Cache-Control": "private, max-age=300" });
  } catch (err) {
    logger.error("speed record failed", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
