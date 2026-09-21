// GET /api/stats/speed-record — рекорд скорости за всё время (§4.5 MaxSpeedAllTime).
// v2.13.0 (Ф1): KPI «Рекорд скорости» раньше был захардкожен «—» — метрика
// не считалась ни одним эндпоинтом. Здесь: максимум по всем живым сессиям
// тем же анти-джиттер конвейером, что и §4.4 MaxSpeed (normalizeSessionSpeeds
// из kpi.ts — AUDIT B-4 + пересчёт по геометрии для битых полей speed).
// Кэш в памяти 5 минут (по образцу corpus-baselines). Данные — одним JOIN-запросом
// через libsql (кастомный db.ts не exposes gpsPoint.findMany).
//
// v2.27.0 (ПЕРФ-КЭШ, worklog Task ID 3): рекорд считается по Session.statsCache
// (§4.4 MaxSpeed — нормализованный максимум сессии, посчитан конвейером
// session-stats при прогреве кэша): один SELECT мет без выкачки всех
// GPS-точек из Мумбаи (10,2с → ~0,5с). Протухшие/некэшированные сессии
// (recording или первый заход после релиза) добираются прежним JOIN-путём
// ТОЛЬКО по их id — первая загрузка честная, после write-through всё из кэша.
// Точность: payload.maxSpeed округлён до 0,1 м/с (FIX-U2) → рекорд в км/ч
// может отличаться от прямого пересчёта на ≤0,2 км/ч — несущественно для
// витринного KPI. Паритет «сессии <5 точек не участвуют» сохранён.
//
// v2.38.1 (ревью F18): ДВА капа вместо полного скана:
//   • окно выборки — 500 САМЫХ СВЕЖИХ записей (ORDER BY startTime DESC LIMIT):
//     полный скан тянул statsCache (JSON до 1,5 МБ/строку) ВСЕХ живых сессий;
//     «всё время» превращается в «окно рекорда» — осознанная цена (KPI витринный,
//     протухшие старые сессии и так не прогреваются — warm только при финализации);
//   • двухфазность: лёгкая фаза НЕ тянет statsCache вообще (только меты свежести),
//     тяжёлая — statsCache только для СВЕЖИХ id из окна, ЧАНКАМИ ≤90;
//   • протухшие id — прежний JOIN-конвейер чанками ≤90 (было: один IN — при
//     >100 протухших сессий (типично после бампа SESSION_CACHE_VERSION)
//     превышение лимита параметров D1 → 500 НАВСЕГДА: прогреть кэш этих сессий
//     некому. Паттерн чанков batch-points.ts здесь был проигнорирован).
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor, sessionScopeSql } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { maxSpeedMs, normalizeSessionSpeeds } from "@/lib/kpi";
import {
  isSessionCacheFresh,
  parseCachedJson,
  type SessionCacheMeta,
} from "@/lib/session-cache";
// v2.41.0 (P0-A, N-8): проверка штампа конвейера статов в payload
import { payloadCacheV, CACHE_PIPELINE_VERSIONS } from "@/lib/cache-versions";
import type { SessionStatsResult } from "@/lib/session-stats";

const CACHE_TTL_MS = 5 * 60 * 1000;
// v2.38.1 (F18): окно рекорда + размер чанка IN-запросов (лимит параметров D1 ≤100)
const RECORD_WINDOW = 500;
const ID_CHUNK = 90;

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

    // mutable-объект: присваивания в consider (замыкание) не сужаются TS-потоком
    const best: { ms: number | null; id: string | null; startTime: string | null } = {
      ms: null,
      id: null,
      startTime: null,
    };
    const consider = (ms: number, id: string, startTime: string) => {
      if (best.ms == null || ms > best.ms) {
        best.ms = ms;
        best.id = id;
        best.startTime = startTime;
      }
    };

    // ——— v2.38.1 (F18): фаза А — лёгкие меты свежести (БЕЗ statsCache), окно 500 ———
    const sc = sessionScopeSql(scope, "s");
    const res = await libsql.execute({
      sql: `SELECT s.id AS sid, s.startTime AS startTime, s.pointCount AS pointCount,
              s.cachePointCount AS cachePointCount, s.cacheVersion AS cacheVersion
            FROM Session s
            WHERE s.deletedAt IS NULL${sc.clause}
            ORDER BY s.startTime DESC
            LIMIT ${RECORD_WINDOW}`,
      args: sc.args as never[],
    });

    const freshIds: string[] = [];
    const freshMetaById = new Map<string, { id: string; startTime: string; pointCount: number | null }>();
    const staleIds: string[] = [];
    for (const row of res.rows as Record<string, unknown>[]) {
      const meta: SessionCacheMeta = {
        id: String(row.sid),
        deviceId: "",
        startTime: String(row.startTime),
        endTime: null,
        deleted: false,
        routeHash: null,
        topologyHash: null,
        pointCount: row.pointCount == null ? null : Number(row.pointCount),
        cachePointCount: row.cachePointCount == null ? null : Number(row.cachePointCount),
        cacheVersion: row.cacheVersion == null ? null : Number(row.cacheVersion),
        statsCache: null,
        eventsCache: null,
        trackCache: null,
      };

      if (isSessionCacheFresh(meta)) {
        // из кэша: §4.4 MaxSpeed сессии (паритет: сессии <5 точек не участвуют)
        freshIds.push(meta.id);
        freshMetaById.set(meta.id, { id: meta.id, startTime: meta.startTime, pointCount: meta.pointCount });
      } else {
        staleIds.push(meta.id); // JOIN-конвейер ТОЛЬКО по id (ниже)
      }
    }

    // ——— v2.38.1 (F18): фаза Б — statsCache только свежих, ЧАНКАМИ ≤90 ———
    for (let i = 0; i < freshIds.length; i += ID_CHUNK) {
      const chunk = freshIds.slice(i, i + ID_CHUNK);
      const ph = chunk.map(() => "?").join(", ");
      const cacheRes = await libsql.execute({
        sql: `SELECT id, statsCache FROM Session WHERE id IN (${ph})`,
        args: chunk as never[],
      });
      for (const row of cacheRes.rows as Record<string, unknown>[]) {
        const meta = freshMetaById.get(String(row.id));
        if (!meta) continue;
        let result = parseCachedJson<SessionStatsResult>(row.statsCache == null ? null : String(row.statsCache));
        // v2.41.0 (P0-A, N-8): payload СТАРОГО конвейера — не «свежий», сессия
        // не участвует по кэш-ветке до пересчёта (write-through stats/batch /
        // backfill-caches); maxSpeed честнее пропустить, чем взять из до-N-3
        if (result != null && payloadCacheV(result) !== CACHE_PIPELINE_VERSIONS.stats) {
          result = null;
        }
        const payloadMax = result && result.kind === "full" ? result.payload.maxSpeed : null;
        if (payloadMax != null && (result?.payload.pointCount ?? 0) >= 5) {
          consider(payloadMax, meta.id, meta.startTime);
        }
      }
    }

    // ——— протухшие/некэшированные: прежний JOIN-конвейер ТОЛЬКО по их id.
    // v2.38.1 (F18): чанки ≤90 (было: один IN — >100 протухших → «too many SQL
    // variables» D1 → 500 навсегда) ———
    for (let ci = 0; ci < staleIds.length; ci += ID_CHUNK) {
      const staleChunk = staleIds.slice(ci, ci + ID_CHUNK);
      const ph = staleChunk.map(() => "?").join(", ");
      const liveRes = await libsql.execute({
        sql: `SELECT s.id AS sid, s.startTime AS startTime, g.lat, g.lon, g.timestamp, g.speed, g.bearing, g.accuracy
              FROM Session s JOIN GpsPoint g ON g.sessionId = s.id
              WHERE s.deletedAt IS NULL AND s.id IN (${ph})
              ORDER BY s.startTime ASC, g.timestamp ASC`,
        args: staleChunk as never[],
      });

      // Группировка точек по сессиям (строки уже в хронологическом порядке).
      const bySession = new Map<string, { startTime: string; points: Array<{ lat: number; lon: number; timestamp: number; speed: number | null; bearing: number | null; accuracy: number | null; altitude: null }> }>();
      for (const row of liveRes.rows as Record<string, unknown>[]) {
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

      for (const [sid, { startTime, points }] of bySession) {
        if (points.length < 5) continue;
        const norm = normalizeSessionSpeeds(points);
        const mx = maxSpeedMs(norm);
        if (mx != null) consider(mx, sid, startTime);
      }
    }

    const value: SpeedRecordValue = best.ms != null && best.id != null && best.startTime != null
      ? {
          maxSpeedAllTimeKmh: Math.round(best.ms * 3.6 * 10) / 10,
          sessionId: best.id,
          date: best.startTime,
        }
      : { maxSpeedAllTimeKmh: null, sessionId: null, date: null };

    scopeCache.set(cacheKey, { value, ts: Date.now() });
    return json(value, 200, { "X-Request-Id": requestId, "Cache-Control": "private, max-age=300" });
  } catch (err) {
    logger.error("speed record failed", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
