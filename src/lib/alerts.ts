// src/lib/alerts.ts — P2-16: AlertManager-правила по спеке §14.4 поверх починенных
// счётчиков (P1-10). Шесть правил: ingest_error_rate, traffic_job_dead_rate,
// backup_failure, db_size_growth, api_latency_p95, worker_stuck.
// Ограничения честно задокументированы в docs/OPERATIONS.md:
//   - кольцевые буферы живут в памяти инстанса (рестарт обнуляет историю);
//   - db_size_growth хранит последнюю выборку в таблице _AlertState (SQLite);
//   - уведомления — SLACK_WEBHOOK_URL (если задан), иначе только журнал + /api/admin/alerts.
import { libsql } from "@/lib/db";
import { env } from "@/lib/env";
import { latencyP95Ms } from "@/lib/latency";

export interface AlertRule {
  rule: string;
  description: string;
  firing: boolean;
  value: string | null;
  threshold: string;
  action: string;
  detail?: string; // почему «мало данных» / недоступно
}

export interface AlertEvaluation {
  evaluatedAt: string;
  firingCount: number;
  alerts: AlertRule[];
}

// ——— кольцевые буферы на globalThis ———
interface Stamp {
  t: number;
  ok?: boolean;
  n?: number;
}

const GLOBAL_KEY = "__telemetriaAlertsBuffers";
const g = globalThis as unknown as {
  [GLOBAL_KEY]?: { ingest: Stamp[]; pending: Stamp[] };
};

function buffers() {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { ingest: [], pending: [] };
  return g[GLOBAL_KEY]!;
}

function trimTo<T extends Stamp>(arr: T[], windowMs: number, now: number) {
  while (arr.length > 0 && now - arr[0].t > windowMs) arr.shift();
}

/** Регистрация исхода ingest-запроса (успех = 2xx/дубль, ошибка = 4xx валидации/5xx). */
export function recordIngestOutcome(ok: boolean) {
  const now = Date.now();
  const { ingest } = buffers();
  ingest.push({ t: now, ok });
  trimTo(ingest, 5 * 60 * 1000, now); // окно правила — 5 мин
}

/** Снимок текущего pending (вызывается при каждой оценке — серия для worker_stuck). */
function recordPendingSample(n: number) {
  const now = Date.now();
  const { pending } = buffers();
  pending.push({ t: now, n });
  trimTo(pending, 10 * 60 * 1000, now); // окно правила — 10 мин
}

// ——— KV для межвызовного состояния (db_size_growth) ———
async function ensureStateTable() {
  await libsql.execute(
    "CREATE TABLE IF NOT EXISTS _AlertState (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)"
  );
}

async function stateGet(key: string): Promise<{ value: string; updatedAt: string } | null> {
  await ensureStateTable();
  const r = await libsql.execute({ sql: "SELECT value, updatedAt FROM _AlertState WHERE key = ?", args: [key] });
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return { value: String(row.value), updatedAt: String(row.updatedAt) };
}

async function stateSet(key: string, value: string) {
  await ensureStateTable();
  const nowIso = new Date().toISOString();
  await libsql.execute({
    sql: "INSERT INTO _AlertState (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
    args: [key, value, nowIso],
  });
}

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ——— правила ———

async function ruleIngestErrorRate(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "ingest_error_rate",
    description: "errors/total > 5% за 5 мин",
    threshold: "> 5%",
    action: "Проверить журнал ingest / валидацию payload (Slack/email при SLACK_WEBHOOK_URL)",
  };
  const now = Date.now();
  const { ingest } = buffers();
  trimTo(ingest, 5 * 60 * 1000, now);
  const total = ingest.length;
  if (total < 5) {
    return { ...base, firing: false, value: null, detail: `мало данных (${total} < 5 запросов за окно)` };
  }
  const errors = ingest.filter((s) => !s.ok).length;
  const rate = errors / total;
  return { ...base, firing: rate > 0.05, value: `${(rate * 100).toFixed(1)}% (${errors}/${total})` };
}

async function ruleTrafficJobDeadRate(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "traffic_job_dead_rate",
    description: "dead/total > 10% за 1 час",
    threshold: "> 10%",
    action: "Проверить 2ГИС API (ключ, лимиты, доступность прокси)",
  };
  const r = await libsql.execute({
    sql: "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead FROM TrafficJob WHERE createdAt >= ?",
    args: [isoMsAgo(60 * 60 * 1000)],
  });
  const row = r.rows[0] as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const dead = Number(row.dead ?? 0);
  if (total === 0) {
    return { ...base, firing: false, value: null, detail: "нет задач за последний час" };
  }
  const rate = dead / total;
  return { ...base, firing: rate > 0.1, value: `${(rate * 100).toFixed(1)}% (${dead}/${total})` };
}

async function ruleBackupFailure(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "backup_failure",
    description: "status=failed 3 раза подряд",
    threshold: "3 подряд",
    action: "Ручное вмешательство: проверить BACKUP_STORAGE_DIR и лимиты диска",
  };
  const r = await libsql.execute(
    "SELECT status FROM BackupJob ORDER BY createdAt DESC LIMIT 3"
  );
  const statuses = r.rows.map((row) => String((row as Record<string, unknown>).status));
  if (statuses.length < 3) {
    return { ...base, firing: false, value: null, detail: `меньше 3 запусков (${statuses.length})` };
  }
  const allFailed = statuses.every((s) => s === "failed");
  return {
    ...base,
    firing: allFailed,
    value: statuses.join(","),
    detail: allFailed ? undefined : "последние 3 запуска не все failed",
  };
}

async function ruleDbSizeGrowth(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "db_size_growth",
    description: "рост > 100 МБ/день",
    threshold: "> 100 МБ/день",
    action: "Проверить retention (очистка gpsPoints/аудита)",
  };
  let sizeBytes: number | null = null;
  try {
    const pages = await libsql.execute("PRAGMA page_count");
    const size = await libsql.execute("PRAGMA page_size");
    const pageCount = Number((pages.rows[0] as Record<string, unknown>).page_count);
    const pageSize = Number((size.rows[0] as Record<string, unknown>).page_size);
    if (Number.isFinite(pageCount) && Number.isFinite(pageSize)) sizeBytes = pageCount * pageSize;
  } catch {
    return { ...base, firing: false, value: null, detail: "PRAGMA недоступен для этого движка БД" };
  }
  if (sizeBytes == null) {
    return { ...base, firing: false, value: null, detail: "PRAGMA вернул нечисловое значение" };
  }

  const prev = await stateGet("db_size_bytes");
  await stateSet("db_size_bytes", String(sizeBytes));
  if (!prev) {
    return { ...base, firing: false, value: `${(sizeBytes / 1048576).toFixed(1)} МБ`, detail: "первая выборка — база для следующего сравнения" };
  }
  const prevBytes = Number(prev.value);
  const prevAt = Date.parse(prev.updatedAt);
  const dtHours = (Date.now() - prevAt) / 3600000;
  if (!Number.isFinite(prevBytes) || !Number.isFinite(prevAt) || dtHours < 1) {
    return { ...base, firing: false, value: `${(sizeBytes / 1048576).toFixed(1)} МБ`, detail: "предыдущая выборка свежее 1 ч — ждём накопления" };
  }
  const growthPerDayMb = ((sizeBytes - prevBytes) / dtHours) * 24 / 1048576;
  return {
    ...base,
    firing: growthPerDayMb > 100,
    value: `${growthPerDayMb >= 0 ? "+" : ""}${growthPerDayMb.toFixed(1)} МБ/день (текущий размер ${(sizeBytes / 1048576).toFixed(1)} МБ)`,
  };
}

async function ruleApiLatencyP95(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "api_latency_p95",
    description: "p95 > 2 сек за 5 мин",
    threshold: "> 2000 мс",
    action: "Масштабирование инстанса (Render: план/автоскейл)",
  };
  const { p95, samples } = latencyP95Ms();
  if (p95 == null) {
    return { ...base, firing: false, value: null, detail: `мало данных (${samples} < 10 замеров за окно)` };
  }
  return { ...base, firing: p95 > 2000, value: `${Math.round(p95)} мс (${samples} замеров)` };
}

async function ruleWorkerStuck(): Promise<AlertRule> {
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "worker_stuck",
    description: "pending > 50 в течение 10 мин",
    threshold: "pending > 50",
    action: "Перезапуск воркера (Render: restart service)",
  };
  let pendingNow: number | null = null;
  try {
    const r = await libsql.execute("SELECT COUNT(*) AS n FROM TrafficJob WHERE status = 'pending'");
    pendingNow = Number((r.rows[0] as Record<string, unknown>).n);
  } catch {
    return { ...base, firing: false, value: null, detail: "не удалось запросить TrafficJob" };
  }
  const now = Date.now();
  const { pending } = buffers();
  recordPendingSample(pendingNow as number);
  trimTo(pending, 10 * 60 * 1000, now);
  const windowSamples = pending.length;
  if (windowSamples < 2) {
    return { ...base, firing: false, value: `pending=${pendingNow}`, detail: "нужно ≥ 2 оценки за 10 мин (cron каждые 5 мин)" };
  }
  const stuckAllWindow = pending.every((s) => (s.n as number) > 50);
  return {
    ...base,
    firing: stuckAllWindow,
    value: `pending=${pendingNow} (${windowSamples} оценок за окно)`,
  };
}

/** Полная оценка всех правил §14.4. Не бросает исключений — правило с ошибкой помечается detail. */
export async function evaluateAlerts(): Promise<AlertEvaluation> {
  const defs: Array<() => Promise<AlertRule>> = [
    ruleIngestErrorRate,
    ruleTrafficJobDeadRate,
    ruleBackupFailure,
    ruleDbSizeGrowth,
    ruleApiLatencyP95,
    ruleWorkerStuck,
  ];
  const alerts: AlertRule[] = [];
  for (const run of defs) {
    try {
      alerts.push(await run());
    } catch (err) {
      alerts.push({
        rule: "evaluation_error",
        description: "ошибка вычисления правила",
        firing: false,
        value: null,
        threshold: "—",
        action: "Проверить журнал",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    evaluatedAt: new Date().toISOString(),
    firingCount: alerts.filter((a) => a.firing).length,
    alerts,
  };
}

/** Уведомление о сработавших правилах (Slack, если SLACK_WEBHOOK_URL задан). */
export async function notifyFiring(evaluation: AlertEvaluation): Promise<number> {
  const firing = evaluation.alerts.filter((a) => a.firing);
  if (firing.length === 0) return 0;
  const webhook = env().SLACK_WEBHOOK_URL;
  if (!webhook) return firing.length; // нет вебхука — только журнал/API (задокументировано)
  const text = [
    "🚨 «Телеметрия поездок»: сработали правила алертов (§14.4)",
    ...firing.map((a) => `• ${a.rule}: ${a.value ?? "?"} — порог ${a.threshold}. Действие: ${a.action}`),
  ].join("\n");
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // доставка уведомления не должна ломать оценку — ошибка видна в журнале вызывающего
  }
  return firing.length;
}
