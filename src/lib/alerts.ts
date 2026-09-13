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

async function stateDelete(key: string) {
  await ensureStateTable();
  await libsql.execute({ sql: "DELETE FROM _AlertState WHERE key = ?", args: [key] });
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
  // v2.32.0: порог «pending > 50» малозначим при одном пользователе (десятки
  // заданий — норма после нескольких дней). Осмысленный сигнал — ВОЗРАСТ
  // старейшего задания: очередь не двигается. Счётчик остаётся как OR-условие
  // (массовый backlog), возраст — как основной.
  const base: Omit<AlertRule, "firing" | "value"> = {
    rule: "worker_stuck",
    description: "старейший pending > 30 мин ИЛИ pending > 50 в течение 10 мин",
    threshold: "age > 30 мин | pending > 50",
    action: "Перезапуск воркера (Render: restart service)",
  };
  let pendingNow: number | null = null;
  let oldestPendingSec: number | null = null;
  try {
    const r = await libsql.execute("SELECT COUNT(*) AS n, MIN(scheduledFor) AS oldest FROM TrafficJob WHERE status = 'pending'");
    const row = r.rows[0] as Record<string, unknown>;
    pendingNow = Number(row.n);
    if (row.oldest != null) {
      const oldestMs = Date.parse(String(row.oldest));
      if (Number.isFinite(oldestMs)) oldestPendingSec = Math.max(0, (Date.now() - oldestMs) / 1000);
    }
  } catch {
    return { ...base, firing: false, value: null, detail: "не удалось запросить TrafficJob" };
  }
  const now = Date.now();
  const { pending } = buffers();
  recordPendingSample(pendingNow as number);
  trimTo(pending, 10 * 60 * 1000, now);
  const windowSamples = pending.length;
  const stuckAllWindow = windowSamples >= 2 && pending.every((s) => (s.n as number) > 50);
  const staleAge = oldestPendingSec != null && oldestPendingSec > 30 * 60;
  const ageStr = oldestPendingSec == null ? "?" : `${Math.round(oldestPendingSec / 60)} мин`;
  return {
    ...base,
    firing: staleAge || stuckAllWindow,
    value: `pending=${pendingNow}, старейшему ${ageStr} (${windowSamples} оценок за окно)`,
    detail: staleAge ? "старейшее задание ждёт > 30 мин — воркер не продвигает очередь" : undefined,
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
// ——— v2.32.0: дедупликация уведомлений (претензия №8 ревью) ———

export interface DedupDecision {
  notify: boolean;
  reason: "no-state" | "cooldown" | "reminder" | "clear";
}

/**
 * Чистое решение о дедупе (unit-тестируется). Правило горит:
 *   - состояния нет → уведомить (первое срабатывание);
 *   - уведомляли < cooldown назад → молчать (Slack не спамится каждые 5 мин);
 *   - уведомляли ≥ cooldown назад → уведомить-напоминание (правило всё ещё горит).
 * Правило не горит, но состояние есть → «clear» (вызывающий разоружает ключ).
 */
export function decideDedup(
  firing: boolean,
  lastNotifiedAt: number | null,
  now: number,
  cooldownMs: number
): DedupDecision {
  if (!firing) return { notify: false, reason: "clear" };
  if (lastNotifiedAt == null) return { notify: true, reason: "no-state" };
  if (now - lastNotifiedAt < cooldownMs) return { notify: false, reason: "cooldown" };
  return { notify: true, reason: "reminder" };
}

const DEDUP_STATE_PREFIX = "alert.dedup.";

/** Отправка текста в Slack (shared для алертов и read-back drill). true = доставлено. */
export async function sendSlackMessage(text: string): Promise<boolean> {
  const webhook = env().SLACK_WEBHOOK_URL;
  if (!webhook) return false; // нет вебхука — только журнал/API (задокументировано)
  // HTTP-статус вебхука проверяется: 4xx/5xx от Slack (отозванный/битый webhook)
  // не должны проглатываться, а вызывающий не должен верить в доставку.
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    console.warn(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg: `alerts: Slack webhook ответил ${res.status} — уведомления НЕ доставлены` }));
    return false;
  } catch {
    console.warn(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg: "alerts: Slack webhook недоступен — уведомления НЕ доставлены" }));
    return false;
  }
}

/**
 * Уведомление о сработавших правилах (Slack, если SLACK_WEBHOOK_URL задан).
 * v2.32.0: дедупликация — одно и то же горящее правило уведомляется не чаще
 * раза в ALERT_DEDUP_COOLDOWN_MIN (по умолчанию 60 мин); переход в «не горит»
 * разоружает правило (следующее срабатывание уведомит сразу). Состояние — в
 * _AlertState (переживает рестарт, попадает в бэкапы). Возвращает число правил,
 * о которых фактически доставлено уведомление.
 */
export async function notifyFiring(evaluation: AlertEvaluation): Promise<number> {
  const firing = evaluation.alerts.filter((a) => a.firing);
  const notFiring = evaluation.alerts.filter((a) => !a.firing);

  // Разоружение погасших правил: состояние удаляется → следующее срабатывание
  // уведомит мгновенно, а не будет съедено кулдауном прошлого эпизода.
  for (const a of notFiring) {
    try { await stateDelete(`${DEDUP_STATE_PREFIX}${a.rule}`); } catch { /* best-effort */ }
  }
  if (firing.length === 0) return 0;

  const cooldownMs = env().ALERT_DEDUP_COOLDOWN_MIN * 60 * 1000;
  const now = Date.now();
  const toNotify: Array<{ rule: AlertRule; reminder: boolean }> = [];
  const notified: string[] = [];
  for (const a of firing) {
    let lastNotifiedAt: number | null = null;
    try {
      const prev = await stateGet(`${DEDUP_STATE_PREFIX}${a.rule}`);
      if (prev) {
        const t = Date.parse(prev.updatedAt);
        if (Number.isFinite(t)) lastNotifiedAt = t;
      }
    } catch { /* нет состояния = первое срабатывание */ }
    const d = decideDedup(true, lastNotifiedAt, now, cooldownMs);
    if (d.notify) toNotify.push({ rule: a, reminder: d.reason === "reminder" });
  }
  if (toNotify.length === 0) return 0; // все ещё горят, но уведомлены недавно

  const text = [
    "🚨 «Телеметрия поездок»: сработали правила алертов (§14.4)",
    ...toNotify.map(({ rule, reminder }) =>
      `• ${rule.rule}: ${rule.value ?? "?"} — порог ${rule.threshold}. Действие: ${rule.action}${reminder ? " (напоминание: правило всё ещё горит)" : ""}`
    ),
  ].join("\n");
  const deliveredOk = await sendSlackMessage(text);
  if (!deliveredOk) {
    // нет вебхука или сбой доставки: дедуп-состояние НЕ ставим — иначе следующий
    // успешный цикл был бы съеден кулдауном уведомления, которое не доставлено
    return 0;
  }
  const nowIso = new Date().toISOString();
  for (const { rule } of toNotify) {
    notified.push(rule.rule);
    try { await stateSet(`${DEDUP_STATE_PREFIX}${rule.rule}`, nowIso); } catch { /* best-effort */ }
  }
  return notified.length;
}
