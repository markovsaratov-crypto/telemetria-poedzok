// src/lib/session-cache.ts — v2.27.0: ПЕРСИСТЕНТНЫЙ КЭШ ПРЕДРАСЧЁТА МЕТРИК.
//
// Проблема (замеры прода, worklog Task ID 2): период-агрегат аналитики
// «Всё время» = 29с стенки — батч-роуты пересчитывают CPU-конвейер
// (normalize/state machine/haversine/EcoScore) по 33К GPS-точек КАЖДЫЙ
// раз после истечения 30-секундного TTL на Render free (0.1 CPU).
//
// Решение — та же конвенция, что у Trip с v2.26.0 (§6.1 ТЗ):
//   • Session.statsCache / eventsCache / trackCache — JSON-строки ПОЛНЫХ
//     payloads конвейеров (SessionStatsResult / SessionEventsPayload /
//     TrackPayload). Формат — дословный: ответ из кэша потребляется всеми
//     существующими компонентами без адаптации.
//   • null = «не посчитано» (конвенция §6.1).
//   • Инвалидация — по числу точек: cachePointCount ≠ Session.pointCount
//     → кэш протух, пересчёт на лету + перезапись (write-through). Инжест
//     инкрементит pointCount каждым батчем, а новый пуш после gap>60с
//     создаёт НОВУЮ сессию — закрытая сессия точек не меняет → её кэш
//     валиден навсегда (движение/парковки уже не изменятся).
//   • cacheVersion — версия СХЕМЫ кэша: смена конвейера (полей payload,
//     нормализации) → bump константы → все кэши считаются протухшими
//     и пересчитываются on-demand при первом же запросе.
//
// Точки записи кэша (две, обе идемпотентны):
//   1. Финализация сессии (session-finalize.ts, переход recording→completed,
//      единая точка для инжеста/cron-финализатора/воркера-«жнеца») — фоновый
//      прогрев warmSessionCache: считаем все три payload и пишем кэш, чтобы
//      владелец открыл аналитику уже по готовым цифрам.
//   2. Write-through батч-роутов (stats/events/track): нет кэша/протух —
//      считаем как раньше (тот же конвейер) и ПЕРЕЗАПИСЫВАЕМ кэш. Это же —
//      бэкфилл существующих сессий при первом заходе после релиза.
//
// Важно: route (план-факт) НЕ кэшируется — TrafficJob завершается воркером
// ПОСЛЕ финализации, composeRoute() всегда собирается из живого TrafficJob
// (1 IN-запрос на батч). Кэшируется только deterministic-по-точкам payload.
// EcoScore в кэше посчитан с corpus-базлайнами на момент записи кэша:
// базлайны дрейфуют медленно (corpus растёт новыми сессиями), для закрытых
// исторических сессий это тождественно пересчёту «по состоянию corpus» —
// расхождение не накапливается (корпус-вес старых сессий не растёт).
import { libsql } from "./db";
import { logger } from "./logger";
import { sessionScopeSql, type DataScope } from "./scope";
import { loadSessionsForBatch } from "./batch-points";
import { computeSessionStats, type SessionStatsResult } from "./session-stats";
import { computeSessionEvents, type SessionEventsPayload } from "./session-events";
import { computeSessionTrack } from "./session-track";
import { getCorpusEcoBaselines } from "./eco-corpus";

/**
 * Версия схемы кэша. Любое изменение формы payloads/session-stats.ts /
 * session-events.ts / session-track.ts (поля, нормализация, пороги) → bump
 * здесь: все существующие кэши станут протухшими и пересчитаются on-demand.
 */
export const SESSION_CACHE_VERSION = 10; // v2.40.7 (N-3): фильтр GPS-телепортов — дистанция/avgSpeed/gapTime/трек пересчитываются on-demand; было 9 (v2.38.2: EcoScore penalty-экспонента 1.5→2 (§7.3, ревью F65) — кэшированные EcoScore/rating пересчитываются on-demand; было 8 (v2.33.0: план = время 2ГИС с пробками на момент старта (utc) — planDurationSec/speedDeviationPct/durationDeviationPct в кэшированных payloads пересчитаны; базовая линия §3.2 осталась только для timeLostToTrafficSec)

export interface SessionCacheMeta {
  id: string;
  deviceId: string;
  startTime: string;
  endTime: string | null;
  deleted: boolean;
  routeHash: string | null;
  topologyHash: string | null;
  pointCount: number | null;
  cachePointCount: number | null;
  cacheVersion: number | null;
  statsCache: string | null;
  eventsCache: string | null;
  trackCache: string | null;
}

export interface CacheFieldsOptions {
  stats?: boolean;
  events?: boolean;
  track?: boolean;
}

/**
 * Меты сессий БЕЗ точек + кэш-колонки — один крошечный IN-запрос (≤50 строк).
 * Тяжёлые JSON-колонки подтягиваются ТОЛЬКО те, что нужны вызывающему роуту
 * (статы не тянут мегабайты трека и наоборот). Несуществующие/чужие id в Map
 * не попадают (→ missing у вызывающего) — тот же контракт, что
 * loadSessionsForBatch из batch-points.ts.
 */
export async function loadSessionMetasWithCache(
  ids: string[],
  scope: DataScope | undefined,
  opts: CacheFieldsOptions
): Promise<Map<string, SessionCacheMeta>> {
  const out = new Map<string, SessionCacheMeta>();
  if (ids.length === 0) return out;

  const cols = [
    "id", "deviceId", "startTime", "endTime", "deletedAt",
    "routeHash", "topologyHash", "pointCount", "cachePointCount", "cacheVersion",
  ];
  if (opts.stats) cols.push("statsCache");
  if (opts.events) cols.push("eventsCache");
  if (opts.track) cols.push("trackCache");

  const sc = scope ? sessionScopeSql(scope) : { clause: "", args: [] as unknown[] };
  const ph = ids.map(() => "?").join(", ");
  const res = await libsql.execute({
    sql: `SELECT ${cols.join(", ")} FROM Session WHERE id IN (${ph})${sc.clause}`,
    args: [...ids, ...sc.args] as never[],
  });
  for (const row of res.rows as Record<string, unknown>[]) {
    const id = String(row.id);
    out.set(id, {
      id,
      deviceId: String(row.deviceId ?? ""),
      startTime: String(row.startTime),
      endTime: row.endTime == null ? null : String(row.endTime),
      deleted: row.deletedAt != null,
      routeHash: row.routeHash == null ? null : String(row.routeHash),
      topologyHash: row.topologyHash == null ? null : String(row.topologyHash),
      pointCount: row.pointCount == null ? null : Number(row.pointCount),
      cachePointCount: row.cachePointCount == null ? null : Number(row.cachePointCount),
      cacheVersion: row.cacheVersion == null ? null : Number(row.cacheVersion),
      statsCache: row.statsCache == null ? null : String(row.statsCache),
      eventsCache: row.eventsCache == null ? null : String(row.eventsCache),
      trackCache: row.trackCache == null ? null : String(row.trackCache),
    });
  }
  return out;
}

/**
 * Кэш свеж? Версия схемы совпала И число точек на момент расчёта равно
 * текущему Session.pointCount. Инжест пишет pointCount += N каждым батчем —
 * активная recording-сессия автоматически «протухает» и пересчитывается.
 *
 * v2.38.2 (ревью F51): необязательный `fields` делает «свежесть» ЧЕСТНОЙ
 * относительно самих кэш-полей: NULL/пустое/маркер oversized (см.
 * SESSION_CACHE_OVERSIZED ниже) = «не свежо». До этого гвард записи при
 * превышении D1-лимита 2 МБ писал NULL в поле, но проставлял
 * cachePointCount/cacheVersion → функция формально отвечала «да», а
 * негодность кэша каждый call-site выявлял ручной проверкой
 * parseCachedJson(...) == null — хрупкий контракт (легко потерять в новом
 * call-site). Без `fields` — прежняя семантика (только версия+состав):
 * существующие вызовы (speed-record) не меняют поведения.
 */
export function isSessionCacheFresh(
  meta: SessionCacheMeta,
  fields?: Array<"stats" | "events" | "track">
): boolean {
  const base =
    meta.cacheVersion === SESSION_CACHE_VERSION &&
    meta.cachePointCount != null &&
    meta.pointCount != null &&
    meta.cachePointCount === meta.pointCount;
  if (!base || !fields || fields.length === 0) return base;
  return fields.every((f) =>
    isCacheFieldUsable(
      f === "stats" ? meta.statsCache : f === "events" ? meta.eventsCache : meta.trackCache
    )
  );
}

// ——— v2.38.2 (ревью F51): ЯВНЫЙ маркер oversized-кэша ———
// Payload > D1-лимита строки (гвард в persistSessionCaches) физически не
// может быть сохранён. Раньше такое поле писалось как NULL — неотличимо
// от «не посчитано», а cachePointCount/cacheVersion при этом
// проставлялись → формальная «свежесть» при негодном кэше + БЕССМЫСЛЕННЫЙ
// UPDATE (write-amplification) на каждый запрос такой сессии. Теперь:
//   • поле хранит МАРКЕР: parseCachedJson возвращает null (не JSON),
//     isSessionCacheFresh(meta, ["track"]) честно отвечает «не свежо»;
//   • persistSessionCaches пропускает запись строк, где ВСЕ запрошенные
//     поля — маркер/NULL (см. комментарий там) — пересчёт on-demand
//     остаётся (данные обязаны попасть в ответ), но rows_written D1
//     больше не сгорают на перезапись того же состояния.
export const SESSION_CACHE_OVERSIZED = "__TELEMAT_CACHE_OVERSIZED__";

/** Поле кэша пригодно к использованию? NULL/пусто/маркер oversized → нет. */
export function isCacheFieldUsable(raw: string | null): boolean {
  return raw != null && raw !== "" && raw !== SESSION_CACHE_OVERSIZED;
}

/** Безопасный разбор JSON-кэша: битая строка = «нет кэша» (пересчёт).
 * v2.38.2 (F51): маркер oversized — явная ветка (самодокументирование
 * контракта, не полагаемся на исключение JSON.parse). */
export function parseCachedJson<T>(raw: string | null): T | null {
  if (raw === SESSION_CACHE_OVERSIZED) return null;
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface SessionCacheWriteRow {
  id: string;
  /** Число точек, ПО КОТОРОМУ считали (фактическая длина загруженного потока). */
  cachePointCount: number;
  statsJson?: string;
  eventsJson?: string;
  trackJson?: string;
}

/**
 * Перезапись кэша, чанками по 8 UPDATE параллельно (RTT Мумбаи ~200мс →
 * 25 сессий ≈ один чанк-такт). cachePointCount пишем = Session.pointCount
 * НА МОМЕНТ SELECT меты (НЕ фактическая длина потока): (а) инжест
 * инкрементит pointCount каждым батчем → новые точки инвалидируют кэш;
 * (б) исторические расхождения pointCount↔GpsPoint не «протухляют» кэш
 * вечно (состав закрытой сессии заморожен — расчёт по факту корректен);
 * (в) гонка «точки пришли между SELECT и UPDATE» — UPDATE меты сделает
 * pointCount ≠ cachePointCount → кэш пересчитается следующим запросом.
 * updatedAt НЕ трогаем: кэш — не изменение данных сессии; лишний UPDATE
 * updatedAt отложил бы закрытие «зависшей» recording-сессии финализатором
 * (stale-порог по updatedAt). Сбой записи — warn (кэш пересчитается).
 */
export async function persistSessionCaches(
  rows: SessionCacheWriteRow[],
  fields: Array<"stats" | "events" | "track">
): Promise<void> {
  if (rows.length === 0 || fields.length === 0) return;
  const CHUNK = 8;
  const chunks: SessionCacheWriteRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  const sets = ["cachePointCount = ?", "cacheVersion = ?"];
  if (fields.includes("stats")) sets.push("statsCache = ?");
  if (fields.includes("events")) sets.push("eventsCache = ?");
  if (fields.includes("track")) sets.push("trackCache = ?");
  const sql = `UPDATE Session SET ${sets.join(", ")} WHERE id = ?`;

  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      Promise.all(
        chunk.map((row) => {
          const args: unknown[] = [row.cachePointCount, SESSION_CACHE_VERSION];
          // v2.37.0 (миграция D1): строка/блоб в D1 ≤ 2 МБ. Кэш — производные
          // данные (null = «не посчитано», пересчёт on-demand): oversized-payload
          // помечается МАРКЕРОМ SESSION_CACHE_OVERSIZED (v2.38.2, F51; раньше —
          // NULL, неотличимый от «не посчитано») — сессия пересчитывается при
          // каждом запросе (замеры сентября 2026: единственный кейс — trackCache
          // 4 МБ одной сессии из 56К точек). На Turso-пути гвард нейтрален.
          const D1_MAX_CACHE = 1_500_000; // запас до лимита 2 МБ
          const guard = (name: "statsJson" | "eventsJson" | "trackJson", v: string | undefined): string | null => {
            if (v == null) return null;
            if (v.length > D1_MAX_CACHE) {
              logger.warn("session cache payload oversized → marker (per-request recompute)", {
                sessionId: row.id, field: name, bytes: v.length,
              });
              return SESSION_CACHE_OVERSIZED;
            }
            return v;
          };
          const values: Array<string | null> = [];
          if (fields.includes("stats")) values.push(guard("statsJson", row.statsJson));
          if (fields.includes("events")) values.push(guard("eventsJson", row.eventsJson));
          if (fields.includes("track")) values.push(guard("trackJson", row.trackJson));
          // v2.38.2 (ревью F51): write-amplification — если ВСЕ запрошенные поля
          // оказались маркером/NULL, UPDATE не нужен: он записал бы ровно то
          // состояние, которое уже в БД (или перезаписал NULL). Смешанные строки
          // (годное поле + oversized) пишутся как раньше — годные поля обязаны
          // попасть в кэш; oversized-сессия с единственным полем не пишет ВООБЩЕ
          // (пересчёт on-demand — единственный путь данных, D1 rows_written
          // экономятся). cachePointCount при пропуске не пишется — мета
          // остаётся «протухшей», т.е. честно нестабильной для такой сессии.
          if (values.every((v) => v == null || v === SESSION_CACHE_OVERSIZED)) {
            return Promise.resolve();
          }
          args.push(...values);
          args.push(row.id);
          return libsql.execute({ sql, args: args as never[] });
        })
      )
    )
  );
  for (const r of results) {
    if (r.status === "rejected") {
      logger.warn("session cache persist failed (non-fatal)", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
}

/**
 * Фоновый прогрев кэша одной сессии (финализация): полный конвейер всех трёх
 * payloads + запись. Вызывается fire-and-forget — сбой НЕ роняет финализацию.
 * cachePointCount = pointCount меты: новые точки (не бывает у закрытой)
 * инкрементят мету и инвалидируют кэш; см. persistSessionCaches.
 */
export async function warmSessionCache(sessionId: string): Promise<void> {
  const data = await loadSessionsForBatch([sessionId]);
  const entry = data.get(sessionId);
  if (!entry || entry.deleted || entry.points.length === 0) return;

  const eco = await getCorpusEcoBaselines();
  const statsResult: SessionStatsResult = computeSessionStats(
    {
      id: entry.id,
      startTime: entry.startTime,
      endTime: entry.endTime,
      routeHash: entry.routeHash,
      topologyHash: entry.topologyHash,
    },
    entry.points,
    eco
  );
  const events: SessionEventsPayload = computeSessionEvents(entry.id, entry.deviceId, entry.points);
  const track = computeSessionTrack(
    {
      id: entry.id,
      deviceId: entry.deviceId,
      startTime: entry.startTime,
      endTime: entry.endTime,
      pointCount: entry.pointCount,
    },
    entry.points
  );

  await persistSessionCaches(
    [
      {
        id: entry.id,
        cachePointCount: entry.pointCount ?? entry.points.length,
        statsJson: JSON.stringify(statsResult),
        eventsJson: JSON.stringify(events),
        trackJson: JSON.stringify(track),
      },
    ],
    ["stats", "events", "track"]
  );
  logger.info("session cache warmed", { sessionId, points: entry.points.length });
}
