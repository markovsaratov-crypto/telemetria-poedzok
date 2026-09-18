// src/lib/stats-rollup.ts — v2.39.0 (§A1, docs/OPTIMIZATION-PROPOSAL.md Вариант A):
// ДНЕВНЫЕ ROLLUP-АГРЕГАТЫ ДАШБОРДА (materialized-rollup / CQRS-lite).
//
// ПРОБЛЕМА: /api/stats на каждый poll считал COUNT(*) по ВСЕЙ GpsPoint живых
// сессий + heatmap-выборку до 5000 строк — на D1 это rows_read по всей таблице
// точек (квота 5 млн/день выгорала трижды; см. OPERATIONS.md §5а). Таблица
// точек растёт линейно с трафиком, счётчики дашборда — нет.
//
// РЕШЕНИЕ: StatsRollup(day, userId, sessions, points, distanceM, durationSec,
// ecoSum, ecoCount, updatedAt) — О(дней) строк. Дашборд читает SUM по скоупу
// вместо COUNT(*) по точкам; заполнение:
//   • инкременты инжеста (sensorlogger/canonical): points += N, sessions += 1
//     на создание записи — UPSERT «INSERT … ON CONFLICT(day, userId) DO
//     UPDATE SET … = … + excluded.…» (идемпотентен по составу PK);
//   • ленивое заполнение cache-aside (§A1.4): если rollup неполон/несвеж —
//     пересчёт дня из Session (pointCount ДЕНОРМАЛИЗОВАН в Session с v2.26+ —
//     SUM по маленькой таблице вместо O(точек)); дистанция/длительность/эко —
//     мягкие поля из Session.statsCache (JSON SessionStatsResult), заполняются
//     бэкфиллом/warmup, инкременты их не трогают (0 до пересчёта — дашборд их
//     не показывает);
//   • админ-бэкфилл POST /api/admin/backfill-rollup (§A1.7) — диапазон ≤ 92 дней.
//
// КОНСЕРВАТИВНОСТЬ (главное требование задачи): ЛЮБАЯ ошибка rollup-ветки
// (таблицы нет / вайтлист DDL-шлюза 403 / квота D1 / битый JSON statsCache) —
// глотается с warn-логом, вызывающий роут фолбэчится на прежний прямой путь
// v2.38.2. Дашборд не имеет права упасть из-за rollup. Полнота rollup
// СВЕРЯЕТСЯ с лёгким счётчиком Session (COUNT по маленькой таблице):
// SUM(rollup.sessions) == COUNT(Session) И MAX(rollup.updatedAt) >=
// MAX(Session.updatedAt) — только тогда SUM(points) считается честным
// totalPoints; при расхождении запускается фоновое самолечение (backfill)
// и ответ идёт прежним путём.
//
// DDL: идемпотентный ensure-on-boot (паттерн _AlertState / ensureSessionIndexes
// F50 из src/lib/db.ts — здесь отдельным модулем, чтобы не создавать цикл
// импортов db.ts ↔ stats-rollup.ts: этот модуль тянет libsql из db). Шлюз
// d1-gateway вайтлистит таблицы: StatsRollup туда ДОБАВИТ оркестратор при
// обновлении воркера (B-этап); до тех пор все SQL к StatsRollup отвечают 403
// — читатели тихо живут на прежнем пути (это задокументированное состояние).
//
// userId: PK (day, userId) в SQLite не детектит ON CONFLICT с NULL-компонентой
// (NULL ≠ NULL) — поэтому unclaimed хранится как sentinel-пустая строка ""
// (семантика Session.userId IS NULL сохранена конвертацией rollupUserId()).

import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { sessionScopeSql, type DataScope } from "./scope";

// ——— день в TZ владельца (TELEMAT_TIMEZONE) — паттерн TZ-бакетов v2.38.2 §F68 ———
// Дневной бакет rollup считается в поясе оператора (TELEMAT_TIMEZONE, IANA),
// как часовые бакеты §10.3/§10.4 и ToD-бакет §13.4. «Сегодня» дашборда
// (tzOffsetMin клиента, B7/v2.16.0) остаётся на прежнем пути — rollup не
// меняет семантику «сегодня»-счётчиков, только all-time/диапазонные суммы.

const DOW_TZ_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let f = DOW_TZ_FORMATTER_CACHE.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      // невалидное IANA-имя — серверный пояс (lenient, как route-cache.ts §F68)
      f = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    DOW_TZ_FORMATTER_CACHE.set(zone, f);
  }
  return f;
}

/** Смещение зоны (мин, UTC−local) в момент tsMs — приём date-fns-tz. */
export function tzOffsetMin(tsMs: number, zone: string): number {
  const parts = zoneFormatter(zone).formatToParts(tsMs);
  let y = 1970, mo = 1, d = 1, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") mo = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
    else if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") mi = Number(p.value);
    else if (p.type === "second") s = Number(p.value);
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return Math.round((asUtc - Math.floor(tsMs / 1000) * 1000) / 60000);
}

/**
 * Дневной ключ YYYY-MM-DD инстанта tsMs в зоне zone (по умолчанию
 * TELEMAT_TIMEZONE). Чистая функция — тестируется (tests/stats-rollup.test.ts).
 */
export function localDayKey(tsMs: number, zone?: string): string {
  const z = zone ?? env().TELEMAT_TIMEZONE;
  return new Date(tsMs + tzOffsetMin(tsMs, z) * 60_000).toISOString().slice(0, 10);
}

/**
 * UTC-мс начала (полночь) дня `day` в зоне zone. Смещение берётся на полдень
 * UTC дня — в DST-поясах на день перехода граница может съехать на 1 ч
 * (Europe/Saratov без DST — точно; деградация задокументирована).
 */
export function dayStartUtcMs(day: string, zone?: string): number {
  const z = zone ?? env().TELEMAT_TIMEZONE;
  const noon = Date.parse(`${day}T12:00:00Z`);
  const offset = tzOffsetMin(Number.isFinite(noon) ? noon : Date.now(), z);
  return Date.parse(`${day}T00:00:00Z`) - offset * 60_000;
}

/** Сегодняшний день в TELEMAT_TIMEZONE (для инкрементов инжеста/warmup). */
export function todayKey(zone?: string): string {
  return localDayKey(Date.now(), zone);
}

/** Список дней [from, to] включительно (YYYY-MM-DD по календарю UTC-дат). */
export function enumerateDays(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out;
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ——— скоуп → rollup-ключ ———

/** userId-строка rollup: "" = unclaimed (см. шапку NB про NULL-PK). */
export function rollupUserId(scope: DataScope): string {
  return scope.mode === "own" ? String(scope.userId ?? "") : "";
}

function rollupScopeSql(scope: DataScope): { clause: string; args: unknown[] } {
  // unclaimed → userId = '' (только хозяйские строки);
  // own → userId = ?; all → без фильтра (сумма всех строк всех владельцев).
  if (scope.mode === "own") return { clause: " AND userId = ?", args: [String(scope.userId ?? "")] };
  if (scope.mode === "unclaimed") return { clause: " AND userId = ''", args: [] };
  return { clause: "", args: [] };
}

// ——— ensure-on-boot DDL (§A1.2, паттерн F50) ———

let rollupEnsured = false;

/**
 * Идемпотентное создание StatsRollup + индекса. Fire-and-forget: сбой (403
 * вайтлиста DDL шлюза до обновления воркера / сеть) логируется warn и НЕ
 * ретраится до рестарта процесса. NULL-компонента PK непригодна для
 * ON CONFLICT (SQLite) — userId NOT NULL с sentinel '' (см. шапку).
 */
export async function ensureStatsRollupTable(): Promise<void> {
  if (rollupEnsured) return;
  rollupEnsured = true; // до попытки: сбой не ретраится до рестарта (как F50)
  try {
    await libsql.execute(
      `CREATE TABLE IF NOT EXISTS StatsRollup (
        day TEXT NOT NULL,
        userId TEXT NOT NULL DEFAULT '',
        sessions INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        distanceM REAL NOT NULL DEFAULT 0,
        durationSec INTEGER NOT NULL DEFAULT 0,
        ecoSum REAL NOT NULL DEFAULT 0,
        ecoCount INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (day, userId)
      )`
    );
    await libsql.execute(
      "CREATE INDEX IF NOT EXISTS StatsRollup_userId_day_idx ON StatsRollup(userId, day)"
    );
    logger.info("StatsRollup table ensured (v2.39.0 §A1)");
  } catch (err) {
    logger.warn("StatsRollup ensure failed (non-fatal; на D1 — вайтлист DDL шлюза, см. §A1 в stats-rollup.ts)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ——— чтение (§A1.3) ———

export interface RollupSummary {
  /** SUM(sessions) по скоупу; 0 при пустой таблице. */
  sessions: number;
  /** SUM(points) по скоупу. */
  points: number;
  /** MAX(updatedAt) rollup-строк скоупа (мс epoch; 0 = строк нет). */
  maxUpdatedAt: number;
  /** Дни за последние 84 дня (для heatmap): {day, points, sessions}. */
  recentDays: Array<{ day: string; points: number; sessions: number }>;
}

/**
 * Сводка rollup по скоупу. Возвращает null, если rollup недоступен
 * (таблицы нет / 403 шлюза / STATS_ROLLUP_ENABLED=false) — вызывающий обязан
 * фолбэчиться на прежний путь. НЕ бросает исключений наружу.
 */
export async function readRollupSummary(scope: DataScope, recentDaysBack = 84): Promise<RollupSummary | null> {
  if (env().STATS_ROLLUP_ENABLED !== "true") return null;
  try {
    void ensureStatsRollupTable(); // лениво (boot мог не успеть); fire-and-forget
    const sc = rollupScopeSql(scope);
    const res = await libsql.execute({
      sql: `SELECT
              COALESCE(SUM(sessions), 0) AS s,
              COALESCE(SUM(points), 0) AS p,
              MAX(updatedAt) AS maxupd
            FROM StatsRollup WHERE 1=1${sc.clause}`,
      args: sc.args as never[],
    });
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const sinceDay = localDayKey(Date.now() - recentDaysBack * 86_400_000);
    const daysRes = await libsql.execute({
      sql: `SELECT day, sessions, points FROM StatsRollup
            WHERE day >= ?${sc.clause} ORDER BY day ASC`,
      args: [sinceDay, ...sc.args] as never[],
    });
    const recentDays = (daysRes.rows as Record<string, unknown>[]).map((r) => ({
      day: String(r.day),
      sessions: Number(r.sessions ?? 0),
      points: Number(r.points ?? 0),
    }));
    const maxupdRaw = row.maxupd;
    const maxUpdatedAt =
      maxupdRaw == null ? 0 : Number.isFinite(Date.parse(String(maxupdRaw))) ? Date.parse(String(maxupdRaw)) : 0;
    return {
      sessions: Number(row.s ?? 0),
      points: Number(row.p ?? 0),
      maxUpdatedAt,
      recentDays,
    };
  } catch (err) {
    // 403 шлюза (StatsRollup не в ALLOWED_TABLES до обновления воркера) —
    // ожидаемое состояние до B-этапа; читатель живёт на прежнем пути.
    logger.warn("StatsRollup read failed (fallback to direct path)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Чистая проверка полноты rollup против лёгких счётчиков Session
 * (COUNT по маленькой таблице — уже считается дашбордом). Критерии:
 *   1. sessions-сумма совпала с числом живых сессий скоупа (нет пропущенных дней);
 *   2. rollup свежее последнего обновления сессий (инкремент не потерялся).
 * Тестируется юнит-тестом (tests/stats-rollup.test.ts).
 */
export function rollupIsUsable(
  summary: RollupSummary | null,
  sessionCount: number,
  maxSessionUpdatedAt: number
): boolean {
  if (summary == null) return false;
  if (summary.sessions !== sessionCount) return false;
  // freshness: rollup обязан «видеть» последнее изменение сессий скоупа
  // (обнуляется на 0 при пустой таблице → только полная сверка sessions).
  if (maxSessionUpdatedAt > 0 && summary.maxUpdatedAt < maxSessionUpdatedAt) return false;
  return true;
}

// ——— запись: инкремент инжеста (§A1.5) ———

/**
 * Инкремент rollup дня (points+N; sessions+1 на создание записи). UPSERT
 * «на пустом месте» создаёт строку с нулями и накатывает дельту. Дистанция/
 * длительность/эко — мягкие поля, инкремент их не трогает (заполняются
 * refreshRollupDays/backfill). Батч, пересёкший полночь, целиком ложится в
 * день последней точки (доминирующий вес) — расхождение лечится пересчётом
 * при полнота-сверке. Ошибка глотается (нефатальный warn).
 */
export async function bumpRollup(
  day: string,
  userId: string | null,
  delta: { sessions?: number; points?: number }
): Promise<void> {
  if (env().STATS_ROLLUP_ENABLED !== "true") return;
  try {
    void ensureStatsRollupTable();
    const uid = userId == null ? "" : String(userId);
    await libsql.execute({
      sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
            VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
            ON CONFLICT(day, userId) DO UPDATE SET
              sessions = sessions + excluded.sessions,
              points = points + excluded.points,
              updatedAt = excluded.updatedAt`,
      args: [day, uid, delta.sessions ?? 0, delta.points ?? 0, new Date().toISOString()],
    });
  } catch (err) {
    logger.warn("StatsRollup bump failed (non-fatal, self-heals via completeness check)", {
      day,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ——— запись: полный пересчёт дней из Session (§A1.4/§A1.7) ———

/** Колонки/JSON-поля statsCache, из которых берутся мягкие поля rollup. */
function softFieldsFromStatsCache(
  statsCacheJson: unknown
): { distanceM: number; durationSec: number; ecoSum: number; ecoCount: number } {
  // Аккуратно (§A1.4): Session.statsCache — сериализованный SessionStatsResult
  // ({kind:"full", payload:{distance, duration, methodology:{ecoScore:{value}}}}).
  // Битый/чужой JSON → нулевой вклад (пересчёт не падает).
  const out = { distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
  if (typeof statsCacheJson !== "string" || statsCacheJson.length === 0) return out;
  if (statsCacheJson === "__TELEMAT_CACHE_OVERSIZED__") return out;
  try {
    const parsed = JSON.parse(statsCacheJson) as {
      kind?: string;
      payload?: {
        distance?: unknown;
        duration?: unknown;
        methodology?: { ecoScore?: { value?: unknown } };
      };
    };
    if (parsed?.kind !== "full" || !parsed.payload) return out;
    const dist = Number(parsed.payload.distance);
    if (Number.isFinite(dist) && dist > 0) out.distanceM += dist;
    const dur = Number(parsed.payload.duration);
    if (Number.isFinite(dur) && dur > 0) out.durationSec += dur;
    const eco = parsed.payload.methodology?.ecoScore?.value;
    if (eco != null && Number.isFinite(Number(eco))) {
      out.ecoSum += Number(eco);
      out.ecoCount += 1;
    }
  } catch {
    // битый кэш — тихий нулевой вклад
  }
  return out;
}

/** Строка rollup для UPSERT-пересчёта (чистая структура — тестируется). */
export interface RollupUpsertRow {
  day: string;
  userId: string; // "" = unclaimed
  sessions: number;
  points: number;
  distanceM: number;
  durationSec: number;
  ecoSum: number;
  ecoCount: number;
}

/** UPSERT полного пересчёта (идемпотентная перезапись — «истина из Session»). */
function rollupUpsertStatements(rows: RollupUpsertRow[]): Array<{ sql: string; args: unknown[] }> {
  return rows.map((r) => ({
    sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day, userId) DO UPDATE SET
            sessions = excluded.sessions,
            points = excluded.points,
            distanceM = excluded.distanceM,
            durationSec = excluded.durationSec,
            ecoSum = excluded.ecoSum,
            ecoCount = excluded.ecoCount,
            updatedAt = excluded.updatedAt`,
    args: [
      r.day,
      r.userId,
      r.sessions,
      r.points,
      r.distanceM,
      r.durationSec,
      r.ecoSum,
      r.ecoCount,
      new Date().toISOString(),
    ],
  }));
}

/**
 * Полный пересчёт диапазона дней [fromDay, toDay] из Session для одного
 * владельца (userId null = unclaimed; 'ALL' — все владельцы: строки по каждой
 * группе). Один SELECT колонок Session (startTime, userId, pointCount,
 * statsCache — маленькая таблица) + JS-группировка по (day, userId) чанками —
 * О(числа сессий), НЕ O(точек). withStatsCache=false — быстрый режим без
 * мягких полей (CSV-импорт/heal: JSON-колонки не тянутся).
 * Ошибки НЕ глотаются здесь (вызывающий решает); интервал бакетов —
 * [dayStartUtcMs(day), dayStartUtcMs(day+1)) по startTime сессии.
 */
export async function recomputeRollupRange(
  fromDay: string,
  toDay: string,
  owner: string | null | "ALL",
  opts?: { withStatsCache?: boolean }
): Promise<{ rowsWritten: number }> {
  if (env().STATS_ROLLUP_ENABLED !== "true") return { rowsWritten: 0 };
  await ensureStatsRollupTable();
  const zone = env().TELEMAT_TIMEZONE;
  const startMs = dayStartUtcMs(fromDay, zone);
  const endMs = dayStartUtcMs(toDay, zone) + 86_400_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return { rowsWritten: 0 };
  }

  const ownerClause =
    owner === "ALL" ? "" : owner == null ? " AND userId IS NULL" : " AND userId = ?";
  const ownerArgs: unknown[] = owner === "ALL" || owner == null ? [] : [owner];
  const cacheCol = opts?.withStatsCache !== false ? ", statsCache" : "";

  const res = await libsql.execute({
    sql: `SELECT startTime, userId, pointCount${cacheCol} FROM Session
          WHERE deletedAt IS NULL AND startTime >= ? AND startTime < ?${ownerClause}`,
    args: [new Date(startMs).toISOString(), new Date(endMs).toISOString(), ...ownerArgs] as never[],
  });

  // JS-группировка по (day, userId) — дни в TELEMAT (SQLite без TZ-функций).
  const groups = new Map<string, RollupUpsertRow>();
  for (const raw of res.rows as Record<string, unknown>[]) {
    const startMs2 = Date.parse(String(raw.startTime));
    if (!Number.isFinite(startMs2)) continue;
    const day = localDayKey(startMs2, zone);
    // сессия могла начаться до fromDay (диапазон по startTime — граница уже
    // отфильтровала), но day-ключ мог съехать на час DST — клипим в диапазон
    if (day < fromDay || day > toDay) continue;
    const uid = raw.userId == null ? "" : String(raw.userId);
    const key = `${day}|${uid}`;
    let row = groups.get(key);
    if (!row) {
      row = { day, userId: uid, sessions: 0, points: 0, distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
      groups.set(key, row);
    }
    row.sessions += 1;
    row.points += Number(raw.pointCount ?? 0);
    if (opts?.withStatsCache !== false) {
      const soft = softFieldsFromStatsCache(raw.statsCache);
      row.distanceM += soft.distanceM;
      row.durationSec += soft.durationSec;
      row.ecoSum += soft.ecoSum;
      row.ecoCount += soft.ecoCount;
    }
  }

  // Пустые группы (дней без сессий нет в результатах) не пишем: отсутствие
  // строки = «день пуст» — читатель суммирует только существующие строки.
  const rows = [...groups.values()].map((r) => ({
    ...r,
    distanceM: Math.round(r.distanceM),
    durationSec: Math.round(r.durationSec),
    ecoSum: Math.round(r.ecoSum * 1000) / 1000,
  }));
  const stmts = rollupUpsertStatements(rows);
  // чанки ≤400 стейтментов (лимит /batch шлюза 500 — db.ts F3/F4/F5)
  for (let i = 0; i < stmts.length; i += 400) {
    const chunk = stmts.slice(i, i + 400);
    await libsql.batch(chunk as never[]);
  }
  return { rowsWritten: rows.length };
}

// ——— фоновое самолечение read-пути (§A1.4 cache-aside) ———

let healInFlight = false;
let healLastRunMs = 0;
const HEAL_COOLDOWN_MS = 60_000;

/**
 * Фоновое восстановление полноты rollup при расхождении с Session
 * (CSV/ZIP-импорт без инкрементов, сбой bump, soft-delete сессии, рестарт):
 * полный пересчёт ВСЕЙ истории скоупа одним проходом (сессии — маленькая
 * таблица). Дедуп: in-flight-флаг + кулдаун 60с (poll дашборда 60с не должен
 * спамить тяжёлым пересчётом). Fire-and-forget: ошибки глотаются.
 */
export function healRollupInBackground(scope: DataScope): void {
  if (env().STATS_ROLLUP_ENABLED !== "true") return;
  const now = Date.now();
  if (healInFlight || now - healLastRunMs < HEAL_COOLDOWN_MS) return;
  healInFlight = true;
  healLastRunMs = now;
  const owner: string | null | "ALL" =
    scope.mode === "own" ? String(scope.userId ?? "") : scope.mode === "unclaimed" ? null : "ALL";
  // Границы: от эпохи (1970) до сегодня — SQL-фильтр по startTime отрежет пустоту.
  void recomputeRollupRange("1970-01-01", todayKey(), owner, { withStatsCache: true })
    .then((r) => {
      logger.info("StatsRollup background heal done (§A1)", { rowsWritten: r.rowsWritten });
    })
    .catch((err) => {
      logger.warn("StatsRollup background heal failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      healInFlight = false;
    });
}

// ——— лёгкая мета сессий скоупа (для полнота-сверки) ———

/**
 * COUNT живых сессий + MAX(updatedAt) скоупа — маленькая таблица, лёгкий
 * запрос (индекс userId, startTime — F50). Возвращает null при ошибке —
 * сверка невозможна, rollup не используется (fallback прежнего пути).
 */
export async function sessionScopeCounters(scope: DataScope): Promise<{ count: number; maxUpdatedAt: number } | null> {
  const sc = sessionScopeSql(scope);
  try {
    const res = await libsql.execute({
      sql: `SELECT COUNT(*) AS c, MAX(updatedAt) AS m FROM Session WHERE deletedAt IS NULL${sc.clause}`,
      args: sc.args as never[],
    });
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const mRaw = row.m;
    const maxUpdatedAt =
      mRaw == null ? 0 : Number.isFinite(Date.parse(String(mRaw))) ? Date.parse(String(mRaw)) : 0;
    return { count: Number(row.c ?? 0), maxUpdatedAt };
  } catch (err) {
    logger.warn("sessionScopeCounters failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
