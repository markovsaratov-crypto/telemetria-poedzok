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

const TRACE_KEY = "diag.ingest.trace";
const MAX_RECENT = 20;

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
  void (async () => {
    try {
      const trace = await readIngestTrace();
      const recent = [a, ...trace.recent].slice(0, MAX_RECENT);
      const payload = JSON.stringify({ last: a, recent });
      const now = new Date().toISOString();
      await libsql.execute({
        sql: `INSERT INTO Setting (key, value, updatedAt, updatedBy)
              VALUES (?, ?, ?, 'ingest-trace')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
        args: [TRACE_KEY, payload, now],
      });
    } catch (err) {
      logger.warn("ingest trace write failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
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
    );
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
