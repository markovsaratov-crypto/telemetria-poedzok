// src/lib/ingest-trace.ts — DIAG-1: постоянная трассировка попыток инжеста.
//
// Проблема (кейс 29–31.08): SensorLogger показывает «отправлено успешно»,
// но поездок в БД нет. «Тихие» исходы инжеста не оставляли в БД ни следа:
//   • пустой батч (Test Push)      → 200 OK «Push test passed»
//   • батч без GPS (сенсоры без location) → 200 OK «Push test passed»
//   • все точки отброшены фильтром accuracy > 100 м (AUDIT B-5) → 200 OK
//   • 401 (неверный токен) / 400 (невалидный формат)
// Приложение считает HTTP 200 успехом — пользователь видит «отправлено»,
// а диагностика на сервере невозможна: Session/GpsPoint пусты, in-memory
// метрики сбрасываются при каждом рестарте Render (free-план).
//
// Решение: каждая АВТОРИЗОВАННАЯ попытка инжеста пишется в Setting
// «diag.ingest.trace» — последняя попытка + кольцевой буфер 20 последних.
// Переживает рестарты и деплои. Читается в /api/stats (поле ingestTrace)
// и отображается в АДМИН → L1 «Состояние системы».
// Неавторизованные попытки в БД не пишутся (анти-абьюз: анонимный спам
// не должен порождать записи) — видны только в /api/metrics
// (счётчик ingest_unauthorized_total, in-memory).
import { libsql } from "./db";
import { inc } from "./metrics";
import { logger } from "./logger";
import { upsertSetting } from "./settings"; // v2.16.0 (D-14): единый UPSERT Setting

const TRACE_KEY = "diag.ingest.trace";
const MAX_RECENT = 20;

// v2.10.8: полный дамп последнего нераспознанного батча (no_gps/empty/invalid).
// sample в трейсе обрезан до ~300 символов — его хватает для формы, но не для
// точечного расширения парсера (кейс 01.09: sample показал accelerometer,
// а как выглядит location-запись — не видно). Дамп хранит тело целиком
// (до 64 КБ), только последнее, перезаписывается при каждом новом no_gps.
const RAW_KEY = "diag.ingest.raw";
const MAX_RAW_CHARS = 64_000;
// v2.11.0 (АУДИТ C-32): TTL сырого дампа — 24 часа. Полноразмерное тело с
// accelerometer/координатами не должно жить в БД вечно; новый нераспознанный
// батч всё равно перезапишет его.
const RAW_TTL_MS = 24 * 60 * 60 * 1000;

export type IngestRoute = "sensorlogger" | "ingest";

export type IngestOutcome =
  | "accepted" // точки приняты, сессия создана/продолжена
  | "empty" // пустой батч (Test Push)
  | "no_gps" // формат валидный, но GPS-точек не извлечено
  | "dropped_all" // все точки отброшены фильтром accuracy > 100 м
  | "invalid" // 400: невалидный формат (zod)
  | "duplicate"; // идемпотентное попадание (§6.7)

export interface IngestAttempt {
  at: string; // ISO-время попытки (серверное)
  route: IngestRoute;
  deviceId: string | null;
  outcome: IngestOutcome;
  points: number; // принято точек
  dropped: number; // отброшено по accuracy
  bytes: number | null; // размер тела запроса
  // v2.10.7: образец структуры payload для нераспознанных батчей (no_gps/empty/invalid) —
  // показывает, ПОД КАКИМИ КЛЮЧАМИ лежат данные, чтобы расширить парсер.
  sample?: string | null;
}

export interface IngestTrace {
  last: IngestAttempt | null;
  recent: IngestAttempt[];
  updatedAt: string | null;
}

const OUTCOME_HELP: Record<IngestOutcome, string> = {
  accepted: "Ingest attempts that accepted points",
  empty: "Ingest attempts with empty batch (test push)",
  no_gps: "Ingest attempts without extractable GPS points",
  dropped_all: "Ingest attempts where all points were dropped by accuracy filter",
  invalid: "Ingest attempts rejected by validation (400)",
  duplicate: "Ingest attempts deduplicated by (deviceId, clientId)",
};

/**
 * Записать попытку инжеста (fire-and-forget: сбой трассировки никогда
 * не должен ронять сам инжест — это диагностический побочный эффект).
 */
export function recordIngestAttempt(a: IngestAttempt): void {
  inc("ingest_attempts_total", "Ingest attempts (all outcomes)", 1, a.route);
  if (a.outcome !== "accepted") {
    inc(`ingest_${a.outcome}_total`, OUTCOME_HELP[a.outcome], 1, a.route);
  }
  // v2.11.0 (АУДИТ C-17): запись трейса сериализована in-process цепочкой —
  // раньше параллельные попытки читали один буфер и перезаписывали друг друга
  // (last-writer-wins терял записи кольца).
  traceWriteQueue = traceWriteQueue.then(() => writeTraceAttempt(a)).catch(() => {});
}

let traceWriteQueue: Promise<void> = Promise.resolve();

async function writeTraceAttempt(a: IngestAttempt): Promise<void> {
  try {
    const trace = await readIngestTrace();
    const recent = [a, ...trace.recent].slice(0, MAX_RECENT);
    const payload = JSON.stringify({ last: a, recent });
    await upsertSetting(TRACE_KEY, payload, "ingest-trace");
  } catch (err) {
    logger.warn("ingest trace write failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Прочитать трассировку — напрямую из БД, мимо кэша настроек (60 c TTL):
 * диагностика должна показывать свежее состояние канала.
 */
export async function readIngestTrace(): Promise<IngestTrace> {
  try {
    const res = await libsql.execute({
      sql: `SELECT value, updatedAt FROM Setting WHERE key = ?`,
      args: [TRACE_KEY],
    });
    if (res.rows.length === 0) return { last: null, recent: [], updatedAt: null };
    const row = res.rows[0] as Record<string, unknown>;
    const parsed = JSON.parse(String(row.value)) as Partial<IngestTrace>;
    const recent = (Array.isArray(parsed.recent) ? parsed.recent : []).filter(
      (r) => r && typeof r.at === "string" && typeof r.outcome === "string"
    ) as IngestAttempt[];
    return {
      last: parsed.last ?? recent[0] ?? null,
      recent: recent.slice(0, MAX_RECENT),
      updatedAt: row.updatedAt ? String(row.updatedAt) : null,
    };
  } catch {
    return { last: null, recent: [], updatedAt: null };
  }
}

/** Человекочитаемая расшифровка исхода — для L1 админки. */
export const INGEST_OUTCOME_RU: Record<IngestOutcome, string> = {
  accepted: "точки приняты",
  empty: "пустой батч (test push)",
  no_gps: "нет GPS-точек в батче",
  dropped_all: "все точки отброшены (точность > 100 м)",
  invalid: "невалидный формат (400)",
  duplicate: "дубль (идемпотентность)",
};

// ===== v2.10.8: полный дамп последнего нераспознанного батча =====
export interface IngestRawDump {
  at: string; // ISO-время попытки
  deviceId: string | null;
  route: IngestRoute;
  outcome: IngestOutcome;
  bytes: number; // полный размер тела
  truncated: boolean; // дамп обрезан по MAX_RAW_CHARS
  body: string; // сырое тело (JSON как прислало приложение)
}

/**
 * Сохранить полное тело последнего нераспознанного батча (fire-and-forget).
 * Вызывается ТОЛЬКО для no_gps/empty/invalid — распознанные батчи парсер
 * уже понял, дамп не нужен. Перезаписывает предыдущий дамп.
 */
export function recordIngestRaw(
  a: { at: string; route: IngestRoute; deviceId: string | null; outcome: IngestOutcome },
  bodyStr: string,
): void {
  // v2.16.0 (B-11): дамп пишется ЧЕРЕЗ ту же сериализованную цепочку
  // traceWriteQueue (раньше — голый void-промис, мог интерливиться
  // с read-modify-write трейса по той же таблице Setting).
  traceWriteQueue = traceWriteQueue.then(() => writeRawDump(a, bodyStr)).catch(() => {});
}

async function writeRawDump(
  a: { at: string; route: IngestRoute; deviceId: string | null; outcome: IngestOutcome },
  bodyStr: string,
): Promise<void> {
  try {
    const bytes = Buffer.byteLength(bodyStr);
    const truncated = bodyStr.length > MAX_RAW_CHARS;
    const dump: IngestRawDump = {
      at: a.at,
      deviceId: a.deviceId,
      route: a.route,
      outcome: a.outcome,
      bytes,
      truncated,
      body: truncated ? bodyStr.slice(0, MAX_RAW_CHARS) : bodyStr,
    };
    await upsertSetting(RAW_KEY, JSON.stringify(dump), "ingest-trace");
  } catch (err) {
    logger.warn("ingest raw dump write failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Прочитать дамп — напрямую из БД. Возвращается только по требованию
 * (?ingestRaw=1 в /api/stats), чтобы не таскать 64 КБ в каждом ответе.
 * v2.11.0 (АУДИТ C-32): старше 24 часов → null (дамп протух).
 */
export async function readIngestRaw(): Promise<IngestRawDump | null> {
  try {
    const res = await libsql.execute({
      sql: `SELECT value FROM Setting WHERE key = ?`,
      args: [RAW_KEY],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0] as Record<string, unknown>;
    const parsed = JSON.parse(String(row.value)) as Partial<IngestRawDump>;
    if (!parsed || typeof parsed.body !== "string" || typeof parsed.at !== "string") return null;
    if (Date.now() - Date.parse(parsed.at) > RAW_TTL_MS) return null;
    return parsed as IngestRawDump;
  } catch {
    return null;
  }
}
