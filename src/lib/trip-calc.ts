// src/lib/trip-calc.ts — v2.42.0 «Вариант 1» (запрос владельца 21.09):
// ПРОМЕЖУТОЧНОЕ ХРАНЕНИЕ РАСЧЁТОВ по прошедшим записям старше суток.
//
// ПРОБЛЕМА (замеры Task 28): холодное открытие период-среза качает из D1
// ЖИРНЫЕ JSON-колонки Session (trackCache 1,19 МБ на тяжёлой записи,
// Σ 6,32 МБ на 50 записей), чтобы на 0.1 CPU проредить их до ≤400 точек
// и отдать ~1,4 МБ рендера — 3/4 трафика D1→Render и весь CPU-прореживание
// повторяются КАЖДЫЙ холодный TTL-цикл (Render free ресайклится ежедневно).
// Сырьё (GpsPoint) при протухшем кэше перечитывается первым зрителем
// целиком (урок N-6: 300–450 тыс. rows_read).
//
// РЕШЕНИЕ: TripCalc — компактные РАСЧЁТНЫЕ СНАПШОТЫ финальных записей
// (закрыты > 24 ч — состав точек заморожен, расчёты иммутбельны):
//   • trackJson — РЕНДЕР-форма трека (thinTrackForRender ≤400 тчк, поля
//     {i,t,lat,lng,v,st}) — ровно то, что период-агрегат отправляет клиенту;
//   • eventsJson — рендер-форма событий (thinEventsForRender, капы шапки);
//   • метрические колонки (distanceM/durationSec/avgSpeedMs/maxSpeedMs/
//     ecoScore/teleportDistanceM) — SQL-агрегируемый слой «всех расчётов»
//     (SUM по периодам без разбора JSON; снапшот свежести помечен statsCacheV);
//   • штампы ПО ПОЛЯМ (statsCacheV/eventsCacheV/trackCacheV — конвенция
//     v2.41.0 N-8): bump конвейера протухляет только своё поле снапшота.
//
// МАРШРУТ ДАННЫХ:
//   чтение: track/events batch ?mode=render → финальная запись + свежий
//     штамп → ответ ПРЯМО из TripCalc (без чтения JSON-колонок Session и
//     без прореживания); иначе — прежний путь v2.41.0 (write-through);
//   запись: (а) write-through батч-роутов рендера; (б) warmSessionCache
//     финальных сессий (бэкфилл/прогрев); (в) backfill-caches (инвентарь
//     финальных записей БЕЗ снапшота — анти-джойн, бюджетный проход);
//   удаление: retention-purge hard-delete (снапшот умираёт вместе с
//     записью; restore-core пересчитает on-demand).
//
// КОНСЕРВАТИВНОСТЬ (паттерн StatsRollup §A1 / «B-этап шлюза»): вайтлист
// таблиц d1-gateway обновляется ОТДЕЛЬНЫМ деплоем воркера (см.
// cloudflare-worker/d1-gateway.js ALLOWED_TABLES + CREATE_TRIPCALC_RE).
// До этого деплоя ЛЮБОЙ SQL к TripCalc получает 403 → все ветки этого
// модуля тихо деградируют на путь v2.41.0 (Session-кэш + прореживание на
// лету): корректность не меняется, выигрываются только байты/CPU. DDL —
// ensure-on-boot c таймер-ретраем (10 мин): после деплоя шлюза таблица
// поднимается без рестарта инстанса.
//
// day — localDayKey(startTime) в TELEMAT_TIMEZONE (паттерн StatsRollup):
// срез «7 дней» = day >= localDayKey(from) — календарный бакет среза.

import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { sessionScopeSql, type DataScope } from "./scope";
import { localDayKey } from "./stats-rollup";
import { CACHE_PIPELINE_VERSIONS, type SessionCacheField } from "./cache-versions";
import { inc } from "./metrics";

/** Порог финальности: запись закрыта > 24 ч → состав точек заморожен. */
export const TRIP_CALC_MIN_AGE_MS = 86_400_000;

/** Рендер-форма трека хранится с потолком по умолчанию (клиент = 400). */
export const TRIPCALC_TRACK_RENDER_MAX_POINTS = 400;

/** Гвард D1-строки/тела шлюза: поле снапшота больше — не пишем (COALESCE
 * сохранит прежнее значение; сервер у пути Session-кэша). */
const TRIPCALC_FIELD_MAX_CHARS = 1_500_000;

/** Ретрай ensure после сбоя (403 до деплоя шлюза / сеть): 10 минут. */
const TRIPCALC_ENSURE_RETRY_MS = 10 * 60_000;

export function tripCalcEnabled(): boolean {
  return env().TRIP_CALC_ENABLED === "true";
}

/** Скоуп → SQL-клауза TripCalc: userId NOT NULL с sentinel '' (как
 * rollupScopeSql в stats-rollup.ts) — НЕ sessionScopeSql: его «userId IS NULL»
 * для unclaimed никогда не матчит NOT NULL-колонку TripCalc. Экспорт —
 * для юнит-теста инварианта скоупов. */
export function tripCalcScopeSql(scope: DataScope): { clause: string; args: unknown[] } {
  if (scope.mode === "own") return { clause: " AND userId = ?", args: [String(scope.userId ?? "")] };
  if (scope.mode === "unclaimed") return { clause: " AND userId = ''", args: [] };
  return { clause: "", args: [] };
}

// ——— финальность (чистая, юнит-тестируется) ———

/**
 * Запись финальна для снапшота: закрыта (endTime есть), не удалена и
 * старше порога 24 ч. Активные recording-сессии и «свежезакрытые»
 * исключены — их расчёты ещё меняются, снапшот писался бы впустую.
 */
export function sessionIsFinalForCalc(
  endTimeIso: string | null,
  deleted: boolean,
  nowMs: number = Date.now()
): boolean {
  if (deleted) return false;
  if (endTimeIso == null || endTimeIso === "") return false;
  const endMs = Date.parse(endTimeIso);
  if (!Number.isFinite(endMs)) return false;
  return nowMs - endMs >= TRIP_CALC_MIN_AGE_MS;
}

// ——— состояние ensure (для /health и диагностики) ———

let ensureState: { ok: boolean | null; error: string | null; at: number } = {
  ok: null,
  error: null,
  at: 0,
};

/** Состояние слоя для /health: enabled/tableOk/lastError (наблюдаемость
 * «шлюз ещё не задеплоен» — как метр квоты m-21, не фатально). */
export function tripCalcStatus(): { enabled: boolean; tableOk: boolean | null; lastError: string | null } {
  return {
    enabled: tripCalcEnabled(),
    tableOk: ensureState.ok,
    lastError: ensureState.error,
  };
}

let ensureInFlight = false;

/**
 * Идемпотентный DDL TripCalc + индексы (паттерн F50/_AlertState/StatsRollup:
 * IF NOT EXISTS = no-op). Сбой (403 вайтлиста до деплоя шлюза / квота /
 * сеть) → ретрай через 10 минут (не «до рестарта», как StatsRollup —
 * таблица должна подняться сразу после деплоя шлюза без ожидания ресайкла
 * Render). Fire-and-forget-safe.
 */
export async function ensureTripCalcTable(): Promise<boolean> {
  if (!tripCalcEnabled()) return false;
  const now = Date.now();
  // успех или недавняя попытка — не дёргаем DDL понапрасну
  if (ensureState.ok === true) return true;
  if (ensureInFlight) return false; // уже идёт попытка — не дублируем
  if (ensureState.ok === false && now - ensureState.at < TRIPCALC_ENSURE_RETRY_MS) return false;
  ensureInFlight = true;
  try {
    await libsql.execute(
      `CREATE TABLE IF NOT EXISTS TripCalc (
        sessionId TEXT PRIMARY KEY,
        userId TEXT NOT NULL DEFAULT '',
        day TEXT NOT NULL DEFAULT '',
        final INTEGER NOT NULL DEFAULT 1,
        statsCacheV INTEGER NOT NULL DEFAULT 0,
        eventsCacheV INTEGER NOT NULL DEFAULT 0,
        trackCacheV INTEGER NOT NULL DEFAULT 0,
        renderMaxPoints INTEGER NOT NULL DEFAULT ${TRIPCALC_TRACK_RENDER_MAX_POINTS},
        pointCount INTEGER NOT NULL DEFAULT 0,
        distanceM REAL NOT NULL DEFAULT 0,
        durationSec INTEGER NOT NULL DEFAULT 0,
        avgSpeedMs REAL,
        maxSpeedMs REAL,
        ecoScore REAL,
        teleportDistanceM REAL NOT NULL DEFAULT 0,
        eventsJson TEXT,
        trackJson TEXT,
        updatedAt TEXT NOT NULL DEFAULT ''
      )`
    );
    await libsql.execute(
      "CREATE INDEX IF NOT EXISTS TripCalc_user_day_idx ON TripCalc(userId, day)"
    );
    await libsql.execute(
      "CREATE INDEX IF NOT EXISTS TripCalc_final_idx ON TripCalc(final, updatedAt)"
    );
    ensureState = { ok: true, error: null, at: now };
    logger.info("TripCalc table ensured (v2.42.0 «Вариант 1»)");
    return true;
  } catch (err) {
    ensureState = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      at: now,
    };
    logger.warn("TripCalc ensure failed (non-fatal; путь v2.41.0; если 403 — задеплойте cloudflare-worker/d1-gateway.js)", {
      error: ensureState.error,
    });
    return false;
  } finally {
    ensureInFlight = false;
  }
}

/** Сброс состояния для тестов. */
export function resetTripCalcEnsureForTests(): void {
  ensureState = { ok: null, error: null, at: 0 };
}

// ——— чтение ———

/** Строка снапшота (поля JSON подтягиваются по запросу — экономия провода). */
export interface TripCalcRow {
  sessionId: string;
  userId: string;
  day: string;
  final: number;
  statsCacheV: number;
  eventsCacheV: number;
  trackCacheV: number;
  renderMaxPoints: number;
  pointCount: number;
  distanceM: number;
  durationSec: number;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  ecoScore: number | null;
  teleportDistanceM: number;
  trackJson: string | null;
  eventsJson: string | null;
}

/**
 * Снапшоты по списку id в зоне видимости. null = слой недоступен (403
 * шлюза до деплоя / квота / сбой) — вызывающий обязан жить на прежнем
 * пути. НЕ бросает исключений наружу.
 */
export async function readTripCalcRows(
  ids: string[],
  scope: DataScope,
  opts: { track?: boolean; events?: boolean }
): Promise<Map<string, TripCalcRow> | null> {
  if (!tripCalcEnabled() || ids.length === 0) return null;
  try {
    void ensureTripCalcTable(); // лениво; 403-состояние поймает SELECT
    const sc = tripCalcScopeSql(scope);
    const jsonCols = `${opts.track ? ", trackJson" : ""}${opts.events ? ", eventsJson" : ""}`;
    const ph = ids.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT sessionId, userId, day, final, statsCacheV, eventsCacheV, trackCacheV,
              renderMaxPoints, pointCount, distanceM, durationSec, avgSpeedMs, maxSpeedMs,
              ecoScore, teleportDistanceM${jsonCols}
            FROM TripCalc WHERE sessionId IN (${ph})${sc.clause}`,
      args: [...ids, ...sc.args] as never[],
    });
    const out = new Map<string, TripCalcRow>();
    for (const row of res.rows as Record<string, unknown>[]) {
      const sessionId = String(row.sessionId);
      out.set(sessionId, {
        sessionId,
        userId: String(row.userId ?? ""),
        day: String(row.day ?? ""),
        final: Number(row.final ?? 0),
        statsCacheV: Number(row.statsCacheV ?? 0),
        eventsCacheV: Number(row.eventsCacheV ?? 0),
        trackCacheV: Number(row.trackCacheV ?? 0),
        renderMaxPoints: Number(row.renderMaxPoints ?? 0),
        pointCount: Number(row.pointCount ?? 0),
        distanceM: Number(row.distanceM ?? 0),
        durationSec: Number(row.durationSec ?? 0),
        avgSpeedMs: row.avgSpeedMs == null ? null : Number(row.avgSpeedMs),
        maxSpeedMs: row.maxSpeedMs == null ? null : Number(row.maxSpeedMs),
        ecoScore: row.ecoScore == null ? null : Number(row.ecoScore),
        teleportDistanceM: Number(row.teleportDistanceM ?? 0),
        trackJson: row.trackJson == null ? null : String(row.trackJson),
        eventsJson: row.eventsJson == null ? null : String(row.eventsJson),
      });
    }
    return out;
  } catch (err) {
    logger.warn("TripCalc read failed (fallback to v2.41.0 path)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ——— решения об обслуживании (чистые, юнит-тестируются) ———

/** Минимальная мета сессии для решения (совместима с SessionCacheMeta). */
export interface TripCalcServeMeta {
  endTime: string | null;
  deleted: boolean;
  pointCount: number | null;
}

/**
 * Готов ли снапшот ТРЕКА обслужить запрос рендера? Инварианты:
 * финальность на момент ЧТЕНИЯ (не записи — перестраховка от «закрыли
 * запись позже порога»), штамп конвейера трека текущий, тот же потолок
 * точек рендера, состав точек не менялся (pointCount), payload есть.
 */
export function tripCalcServesTrack(
  row: TripCalcRow | undefined,
  meta: TripCalcServeMeta,
  renderMaxPoints: number,
  currentTrackV: number = CACHE_PIPELINE_VERSIONS.track,
  nowMs: number = Date.now()
): boolean {
  if (row == null) return false;
  if (row.final !== 1) return false;
  if (!sessionIsFinalForCalc(meta.endTime, meta.deleted, nowMs)) return false;
  if (row.trackCacheV !== currentTrackV) return false;
  if (row.renderMaxPoints !== renderMaxPoints) return false;
  if (row.pointCount !== (meta.pointCount ?? -1)) return false;
  return row.trackJson != null && row.trackJson.length > 0;
}

/**
 * Готов ли снапшот СОБЫТИЙ обслужить рендер-запрос? Рендер-форма событий
 * не параметризована (фиксированные капы thinEventsForRender) — потолок
 * не сверяется. Инварианты финальности/штампа/состава — те же.
 */
export function tripCalcServesEvents(
  row: TripCalcRow | undefined,
  meta: TripCalcServeMeta,
  currentEventsV: number = CACHE_PIPELINE_VERSIONS.events,
  nowMs: number = Date.now()
): boolean {
  if (row == null) return false;
  if (row.final !== 1) return false;
  if (!sessionIsFinalForCalc(meta.endTime, meta.deleted, nowMs)) return false;
  if (row.eventsCacheV !== currentEventsV) return false;
  if (row.pointCount !== (meta.pointCount ?? -1)) return false;
  return row.eventsJson != null && row.eventsJson.length > 0;
}

// ——— метрики расчёта (чистая экстракция из SessionStatsResult) ———

/** SQL-агрегируемые метрики среза из полного расчёта статов. */
export interface TripCalcMetrics {
  distanceM: number;
  durationSec: number;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  ecoScore: number | null;
  teleportDistanceM: number;
}

/**
 * Метрики из SessionStatsResult (обёртка {kind, payload} — как кладёт
 * конвейер session-stats.ts). kind:"empty"/битый JSON → null (снапшот не
 * пишет метрики, SQL-слой их не увидит — честно). Чистая — тестируется.
 */
export function metricsFromStatsResult(result: unknown): TripCalcMetrics | null {
  if (result == null || typeof result !== "object") return null;
  const obj = result as {
    kind?: unknown;
    payload?: {
      distance?: unknown;
      duration?: unknown;
      avgSpeed?: unknown;
      maxSpeed?: unknown;
      teleportDistanceM?: unknown;
      methodology?: { ecoScore?: { value?: unknown } };
    };
  };
  if (obj.kind !== "full" || obj.payload == null || typeof obj.payload !== "object") return null;
  const p = obj.payload;
  const dist = Number(p.distance);
  const dur = Number(p.duration);
  if (!Number.isFinite(dist) || !Number.isFinite(dur)) return null;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const eco = num(p.methodology?.ecoScore?.value);
  return {
    distanceM: Math.round(dist),
    durationSec: Math.round(dur),
    avgSpeedMs: num(p.avgSpeed),
    maxSpeedMs: num(p.maxSpeed),
    ecoScore: eco == null ? null : Math.round(eco * 1000) / 1000,
    teleportDistanceM: Math.round(num(p.teleportDistanceM) ?? 0),
  };
}

// ——— запись: поле-scoped UPSERT (чистый строитель + исполнитель) ———

/** Одна запись снапшота: база + ОПЦИОНАЛЬНЫЕ поля (пишет только владелец поля). */
export interface TripCalcWrite {
  sessionId: string;
  /** Владелец записи (null = unclaimed, sentinel '' как StatsRollup). */
  userId: string | null;
  startTime: string;
  pointCount: number;
  /** Метрики стата + штамп statsCacheV — пишут stats-ветки (warm/бэкфилл). */
  metrics?: TripCalcMetrics;
  /** Рендер-события + штамп — events-ветки. */
  eventsJson?: string;
  /** Рендер-трек + штамп + потолок — track-ветки. */
  trackJson?: string;
  renderMaxPoints?: number;
}

function toDayKey(startTime: string): string {
  try {
    return localDayKey(Date.parse(startTime));
  } catch {
    return "";
  }
}

/**
 * Стейтменты поле-scoped UPSERT: INSERT создаёт строку со всеми полями,
 * ON CONFLICT обновляет БАЗУ всегда, опциональные поля — только если
 * пишущая ветка принесла значение (COALESCE сохраняет чужие поля —
 * track-роут не затирает eventsJson, записанный events-роутом).
 * Порог поля TRIPCALC_FIELD_MAX_CHARS: негабарит → поле пропускается
 * (COALESCE сохранит прежнее; путь сервера = Session-кэш). Чистая —
 * юнит-тестируется.
 */
export function buildTripCalcUpserts(writes: TripCalcWrite[]): Array<{ sql: string; args: unknown[] }> {
  const out: Array<{ sql: string; args: unknown[] }> = [];
  const now = new Date().toISOString();
  for (const w of writes) {
    if (!w.sessionId || w.sessionId.length === 0) continue;
    const metrics = w.metrics ?? null;
    const eventsJson = w.eventsJson != null && w.eventsJson.length <= TRIPCALC_FIELD_MAX_CHARS ? w.eventsJson : null;
    const trackJson = w.trackJson != null && w.trackJson.length <= TRIPCALC_FIELD_MAX_CHARS ? w.trackJson : null;
    if (w.metrics != null && metrics == null) continue; // битые метрики — не пишем вовсе
    if (metrics == null && eventsJson == null && trackJson == null) continue; // нечего писать
    out.push({
      sql: `INSERT INTO TripCalc (sessionId, userId, day, final, pointCount,
              statsCacheV, eventsCacheV, trackCacheV, renderMaxPoints,
              distanceM, durationSec, avgSpeedMs, maxSpeedMs, ecoScore, teleportDistanceM,
              eventsJson, trackJson, updatedAt)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sessionId) DO UPDATE SET
              userId = excluded.userId,
              day = excluded.day,
              final = 1,
              pointCount = excluded.pointCount,
              statsCacheV = COALESCE(excluded.statsCacheV, TripCalc.statsCacheV),
              eventsCacheV = COALESCE(excluded.eventsCacheV, TripCalc.eventsCacheV),
              trackCacheV = COALESCE(excluded.trackCacheV, TripCalc.trackCacheV),
              renderMaxPoints = COALESCE(excluded.renderMaxPoints, TripCalc.renderMaxPoints),
              distanceM = COALESCE(excluded.distanceM, TripCalc.distanceM),
              durationSec = COALESCE(excluded.durationSec, TripCalc.durationSec),
              avgSpeedMs = COALESCE(excluded.avgSpeedMs, TripCalc.avgSpeedMs),
              maxSpeedMs = COALESCE(excluded.maxSpeedMs, TripCalc.maxSpeedMs),
              ecoScore = COALESCE(excluded.ecoScore, TripCalc.ecoScore),
              teleportDistanceM = COALESCE(excluded.teleportDistanceM, TripCalc.teleportDistanceM),
              eventsJson = COALESCE(excluded.eventsJson, TripCalc.eventsJson),
              trackJson = COALESCE(excluded.trackJson, TripCalc.trackJson),
              updatedAt = excluded.updatedAt`,
      args: [
        w.sessionId,
        w.userId == null ? "" : String(w.userId),
        toDayKey(w.startTime),
        w.pointCount,
        metrics ? CACHE_PIPELINE_VERSIONS.stats : null,
        eventsJson != null ? CACHE_PIPELINE_VERSIONS.events : null,
        trackJson != null ? CACHE_PIPELINE_VERSIONS.track : null,
        trackJson != null ? w.renderMaxPoints ?? TRIPCALC_TRACK_RENDER_MAX_POINTS : null,
        metrics ? metrics.distanceM : null,
        metrics ? metrics.durationSec : null,
        metrics ? metrics.avgSpeedMs : null,
        metrics ? metrics.maxSpeedMs : null,
        metrics ? metrics.ecoScore : null,
        metrics ? metrics.teleportDistanceM : null,
        eventsJson,
        trackJson,
        now,
      ],
    });
  }
  return out;
}

/**
 * Запись снапшотов (чанками ≤ 8 стейтментов — паттерн persistSessionCaches).
 * Негабарит тела шлюза исключён полевым гвардом (см. выше). Ошибка —
 * non-fatal warn (снапшот доберёт следующий холодный цикл/бэкфилл).
 * Возвращает число записанных стейтментов.
 */
export async function upsertTripCalc(writes: TripCalcWrite[]): Promise<number> {
  if (!tripCalcEnabled() || writes.length === 0) return 0;
  const stmts = buildTripCalcUpserts(writes);
  if (stmts.length === 0) return 0;
  try {
    void ensureTripCalcTable();
    const CHUNK = 8;
    let written = 0;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      const chunk = stmts.slice(i, i + CHUNK);
      await libsql.batch(chunk as never[]);
      written += chunk.length;
    }
    inc("tripcalc_write_total", "TripCalc snapshot rows upserted (v2.42.0)", written);
    return written;
  } catch (err) {
    logger.warn("TripCalc upsert failed (non-fatal; снапшот доберёт следующий цикл)", {
      rows: writes.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ——— инвентарь бэкфилла: финальные записи БЕЗ снапшота ———

/**
 * Анти-джойн: живые финальные (> 24 ч) записи, у которых нет строки
 * TripCalc (слои шлюза/таблицы недоступны → [] — вызывающий трактует как
 * «инвентарь пуст», не как ошибку: путь v2.41.0 полностью корректен).
 * ORDER BY startTime DESC — свежие первыми (наибольший выигрыш провода).
 */
export async function findFinalSessionsWithoutTripCalc(limit: number): Promise<string[]> {
  if (!tripCalcEnabled()) return [];
  try {
    void ensureTripCalcTable();
    const cutoff = new Date(Date.now() - TRIP_CALC_MIN_AGE_MS).toISOString();
    const res = await libsql.execute({
      sql: `SELECT s.id FROM Session s LEFT JOIN TripCalc t ON t.sessionId = s.id
            WHERE s.deletedAt IS NULL AND s.endTime IS NOT NULL AND s.endTime < ?
              AND t.sessionId IS NULL
            ORDER BY s.startTime DESC LIMIT ?`,
      args: [cutoff, Math.max(1, Math.min(limit, 200))] as never[],
    });
    return (res.rows as Record<string, unknown>[]).map((r) => String(r.id));
  } catch (err) {
    logger.warn("TripCalc inventory failed (non-fatal, treated as empty)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Снапшот из УЖЕ посчитанных кэшей строки Session (лёгкий путь бэкфилла:
 * БЕЗ чтения точек — рендер-формы строятся из персистентных кэшей).
 * Возвращает {written, reason}: reason="session-caches-stale" — вызывающему
 * нужен полный warmSessionCache (сырьевой путь); "not-final" — моложе 24 ч.
 */
export async function upsertTripCalcFromSessionCaches(
  sessionId: string,
  renderMaxPoints: number = TRIPCALC_TRACK_RENDER_MAX_POINTS
): Promise<{ written: boolean; reason: string }> {
  if (!tripCalcEnabled()) return { written: false, reason: "disabled" };
  try {
    const res = await libsql.execute({
      sql: `SELECT userId, startTime, endTime, deletedAt, pointCount,
              statsCache, eventsCache, trackCache, cachePointCount
            FROM Session WHERE id = ?`,
      args: [sessionId] as never[],
    });
    const row = (res.rows as Record<string, unknown>[])[0];
    if (!row) return { written: false, reason: "session-not-found" };
    const endTime = row.endTime == null ? null : String(row.endTime);
    const deleted = row.deletedAt != null;
    if (!sessionIsFinalForCalc(endTime, deleted)) {
      return { written: false, reason: "not-final" };
    }
    const pointCount = row.pointCount == null ? 0 : Number(row.pointCount);
    const cachePointCount = row.cachePointCount == null ? null : Number(row.cachePointCount);
    if (cachePointCount == null || cachePointCount !== pointCount) {
      return { written: false, reason: "session-caches-stale" };
    }
    const startTime = String(row.startTime);
    const userId = row.userId == null ? null : String(row.userId);

    // статы → метрики (+ сверка штампа конвейера в payload)
    const statsRaw = row.statsCache == null ? null : String(row.statsCache);
    let metrics: TripCalcMetrics | null = null;
    if (statsRaw && statsRaw !== "__TELEMAT_CACHE_OVERSIZED__") {
      try {
        const parsed = JSON.parse(statsRaw) as unknown;
        metrics = metricsFromStatsResult(parsed);
      } catch {
        metrics = null;
      }
    }

    // трек → рендер-форма (+ штамп конвейера должен совпадать)
    const trackRaw = row.trackCache == null ? null : String(row.trackCache);
    let trackJson: string | undefined;
    if (trackRaw && trackRaw !== "__TELEMAT_CACHE_OVERSIZED__") {
      try {
        const parsed = JSON.parse(trackRaw) as { cacheV?: unknown; points?: unknown[] };
        if (
          typeof parsed?.cacheV === "number" &&
          parsed.cacheV === CACHE_PIPELINE_VERSIONS.track &&
          Array.isArray(parsed.points) &&
          parsed.points.length > 0
        ) {
          // ленивый импорт — разрыв цикла trip-calc ⇄ track-render
          const { thinTrackForRender } = await import("./track-render");
          const thin = thinTrackForRender(parsed as unknown as Record<string, unknown>, renderMaxPoints);
          trackJson = JSON.stringify(thin);
        }
      } catch {
        trackJson = undefined;
      }
    }

    // события → рендер-форма (+ штамп конвейера)
    const eventsRaw = row.eventsCache == null ? null : String(row.eventsCache);
    let eventsJson: string | undefined;
    if (eventsRaw && eventsRaw !== "__TELEMAT_CACHE_OVERSIZED__") {
      try {
        const parsed = JSON.parse(eventsRaw) as { cacheV?: unknown };
        if (typeof parsed?.cacheV === "number" && parsed.cacheV === CACHE_PIPELINE_VERSIONS.events) {
          const { thinEventsForRender } = await import("./track-render");
          const thin = thinEventsForRender(parsed as unknown as Record<string, unknown>);
          eventsJson = JSON.stringify(thin);
        }
      } catch {
        eventsJson = undefined;
      }
    }

    if (metrics == null && trackJson == null && eventsJson == null) {
      return { written: false, reason: "session-caches-stale" };
    }
    const written = await upsertTripCalc([
      {
        sessionId,
        userId,
        startTime,
        pointCount,
        metrics: metrics ?? undefined,
        trackJson,
        renderMaxPoints: trackJson != null ? renderMaxPoints : undefined,
        eventsJson,
      },
    ]);
    return { written: written > 0, reason: written > 0 ? "written" : "upsert-failed" };
  } catch (err) {
    logger.warn("upsertTripCalcFromSessionCaches failed (non-fatal)", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { written: false, reason: "error" };
  }
}

// ——— удаление (retention purge) ———

/**
 * Снапшок из ТОЛЬКО ЧТО ПОСЧИТАННЫХ конвейером payloads (ветка
 * warmSessionCache: финализация/бэкфилл/прогрев протухших): точек в
 * сырьё больше НЕ ходим — рендер-формы и метрики из готовых объектов.
 * userId подтягивается лёгким SELECT'ом одной строки (loadSessionsForBatch
 * его не выбирает). Не-финальная (< 24 ч) запись снапшот не получает —
 * её расчёты ещё меняются.
 */
export async function upsertTripCalcForWarmedSession(
  entry: {
    id: string;
    startTime: string;
    endTime: string | null;
    pointCount: number | null;
  },
  computed: { stats: unknown; events: unknown; track: unknown },
  renderMaxPoints: number = TRIPCALC_TRACK_RENDER_MAX_POINTS
): Promise<boolean> {
  if (!tripCalcEnabled()) return false;
  if (!sessionIsFinalForCalc(entry.endTime, false)) return false;
  try {
    // userId записи (владение снапшота = владение записи)
    const res = await libsql.execute({
      sql: "SELECT userId FROM Session WHERE id = ?",
      args: [entry.id] as never[],
    });
    const row = (res.rows as Record<string, unknown>[])[0];
    if (!row) return false;
    const userId = row.userId == null ? null : String(row.userId);

    const metrics = metricsFromStatsResult(computed.stats);
    let trackJson: string | undefined;
    {
      const t = computed.track as { cacheV?: unknown; points?: unknown[] } | null;
      if (
        t &&
        typeof t === "object" &&
        typeof t.cacheV === "number" &&
        t.cacheV === CACHE_PIPELINE_VERSIONS.track &&
        Array.isArray(t.points) &&
        t.points.length > 0
      ) {
        const { thinTrackForRender } = await import("./track-render");
        trackJson = JSON.stringify(thinTrackForRender(t as unknown as Record<string, unknown>, renderMaxPoints));
      }
    }
    let eventsJson: string | undefined;
    {
      const e = computed.events as { cacheV?: unknown } | null;
      if (e && typeof e === "object" && typeof e.cacheV === "number" && e.cacheV === CACHE_PIPELINE_VERSIONS.events) {
        const { thinEventsForRender } = await import("./track-render");
        eventsJson = JSON.stringify(thinEventsForRender(e as unknown as Record<string, unknown>));
      }
    }
    if (metrics == null && trackJson == null && eventsJson == null) return false;
    const written = await upsertTripCalc([
      {
        sessionId: entry.id,
        userId,
        startTime: entry.startTime,
        pointCount: entry.pointCount ?? 0,
        metrics: metrics ?? undefined,
        trackJson,
        renderMaxPoints: trackJson != null ? renderMaxPoints : undefined,
        eventsJson,
      },
    ]);
    return written > 0;
  } catch (err) {
    logger.warn("upsertTripCalcForWarmedSession failed (non-fatal)", {
      sessionId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** DELETE-стейтменты чанками ≤ 90 id (D1_PARAM_BUDGET). Чистая — тестируется. */
export function buildTripCalcDeleteStatements(ids: string[]): Array<{ sql: string; args: string[] }> {
  const unique = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  const out: Array<{ sql: string; args: string[] }> = [];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(", ");
    out.push({ sql: `DELETE FROM TripCalc WHERE sessionId IN (${ph})`, args: chunk });
  }
  return out;
}

/** Удаление строк снапшота (purge записи). Ошибка — non-fatal warn. */
export async function deleteTripCalcRows(ids: string[]): Promise<number> {
  if (!tripCalcEnabled() || ids.length === 0) return 0;
  const stmts = buildTripCalcDeleteStatements(ids);
  let deleted = 0;
  for (const stmt of stmts) {
    try {
      const res = await libsql.execute(stmt as never);
      deleted += Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
    } catch (err) {
      logger.warn("TripCalc delete failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return deleted;
}

// ——— лёгкая мета финальных кандидатов для батч-роутов ———

/** Мета без JSON-колонок (лёгкий SELECT фазы 0 рендер-батчей). */
export interface TripCalcCandidate {
  id: string;
  userId: string | null;
  startTime: string;
  endTime: string | null;
  deleted: boolean;
  pointCount: number | null;
}

/**
 * Финальные (> 24 ч) записи списка + missing-инфо: ОДИН лёгкий SELECT
 * (id/userId/startTime/endTime/deletedAt/pointCount, БЕЗ кэш-колонок —
 * фаза 0 не платит за жирь). failed=true → вызывающий живёт на пути v2.41.0
 * для всего списка (scope-фильтр сохранён).
 */
export async function loadFinalCalcCandidates(
  ids: string[],
  scope: DataScope,
  nowMs: number = Date.now()
): Promise<{ candidates: TripCalcCandidate[]; missing: string[]; existing: Map<string, TripCalcCandidate>; failed: boolean }> {
  const empty = { candidates: [] as TripCalcCandidate[], missing: [] as string[], existing: new Map<string, TripCalcCandidate>(), failed: true };
  if (!tripCalcEnabled() || ids.length === 0) return empty;
  try {
    const sc = sessionScopeSql(scope);
    const ph = ids.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT id, userId, startTime, endTime, deletedAt, pointCount
            FROM Session WHERE id IN (${ph})${sc.clause}`,
      args: [...ids, ...sc.args] as never[],
    });
    const existing = new Map<string, TripCalcCandidate>();
    const candidates: TripCalcCandidate[] = [];
    for (const row of res.rows as Record<string, unknown>[]) {
      const c: TripCalcCandidate = {
        id: String(row.id),
        userId: row.userId == null ? null : String(row.userId),
        startTime: String(row.startTime),
        endTime: row.endTime == null ? null : String(row.endTime),
        deleted: row.deletedAt != null,
        pointCount: row.pointCount == null ? null : Number(row.pointCount),
      };
      existing.set(c.id, c);
      if (sessionIsFinalForCalc(c.endTime, c.deleted, nowMs)) candidates.push(c);
    }
    const missing = ids.filter((id) => !existing.has(id));
    return { candidates, missing, existing, failed: false };
  } catch (err) {
    logger.warn("loadFinalCalcCandidates failed (fallback to classic path)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

// ——— (экспорт для роутов/тестов) текущие штампы по полям ———
export { CACHE_PIPELINE_VERSIONS };
export type { SessionCacheField };
