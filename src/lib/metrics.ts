// src/lib/metrics.ts — Prometheus-style метрики (in-memory, без prom-client dep, §7.2)
// P1-10: реестр вынесен на globalThis — раньше instrumentation (воркер) и API-роуты
// получали РАЗНЫЕ экземпляры модуля, и инкременты воркера не видны в /api/metrics.
interface Counter {
  name: string;
  help: string;
  value: number;
  labels: Map<string, number>;
}

interface Gauge {
  name: string;
  help: string;
  value: number;
}

interface MetricsRegistry {
  counters: Map<string, Counter>;
  gauges: Map<string, Gauge>;
}

const GLOBAL_KEY = "__telemetriaMetricsRegistry";
const g = globalThis as unknown as { [GLOBAL_KEY]?: MetricsRegistry };

function registry(): MetricsRegistry {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { counters: new Map(), gauges: new Map() };
  }
  return g[GLOBAL_KEY]!;
}

export function inc(name: string, help = "", by = 1, label?: string) {
  const { counters } = registry();
  let c = counters.get(name);
  if (!c) {
    c = { name, help, value: 0, labels: new Map() };
    counters.set(name, c);
  }
  c.value += by;
  if (label) {
    // P1-10: корректный формат лейблов Prometheus — scope="ingest" вместо сырого {ingest}
    const key = label.includes("=") ? label : `scope="${label.replace(/"/g, "")}"`;
    c.labels.set(key, (c.labels.get(key) || 0) + by);
  }
}

export function set(name: string, value: number, help = "") {
  const { gauges } = registry();
  let gg = gauges.get(name);
  if (!gg) {
    gg = { name, help, value };
    gauges.set(name, gg);
  }
  gg.value = value;
}

// v2.39.0 (§A6): чтение текущего значения counter'а — правило алертов
// d1_quota_70 суммирует дневную корзину по d1_rows_read_total. null = метрика
// не инициализирована (не D1-режим / модуль не подключён) — правило деградирует мягко.
export function counterValue(name: string): number | null {
  const { counters } = registry();
  const c = counters.get(name);
  return c ? c.value : null;
}

export function metricsText(): string {
  const { counters, gauges } = registry();
  const lines: string[] = [];
  for (const c of counters.values()) {
    if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    lines.push(`${c.name} ${c.value}`);
    for (const [label, val] of c.labels.entries()) {
      lines.push(`${c.name}{${label}} ${val}`);
    }
  }
  for (const gg of gauges.values()) {
    if (gg.help) lines.push(`# HELP ${gg.name} ${gg.help}`);
    lines.push(`# TYPE ${gg.name} gauge`);
    lines.push(`${gg.name} ${gg.value}`);
  }
  return lines.join("\n") + "\n";
}

// Инициализация базовых метрик
inc("ingest_total", "Total ingest requests", 0);
inc("ingest_duplicate_total", "Duplicate ingest (idempotency hit)", 0);
inc("traffic_job_completed_total", "Traffic jobs completed", 0);
inc("traffic_job_failed_total", "Traffic jobs failed (attempts, retried)", 0);
// v2.38.1 (ревью F15): gauge терминальных dead-джобов. Раньше /api/metrics
// делал set("traffic_job_failed_total", …) — КОЛЛИЗИЯ с одноимённым counter
// выше: в Prometheus exposition попадали ДВА # TYPE для одного имени
// (counter + gauge) → парсер scrape падает с ошибкой, весь мониторинг
// (счётчики инжеста, джобов, rate-limit) деградирует до нуля сэмплов.
// Gauge переименован в traffic_job_dead_total и считает status='dead'
// (статуса 'failed' в TrafficJob не существует: pending/running/completed/dead
// — старый gauge всегда показывал 0). Оба имени живут здесь — единственный
// источник, роут импортирует константу.
export const TRAFFIC_JOB_DEAD_GAUGE = "traffic_job_dead_total";
set(TRAFFIC_JOB_DEAD_GAUGE, 0, "Traffic jobs dead (terminal, max attempts exceeded)");
inc("routing_fallback_total", "Routing provider fallbacks", 0);
inc("rate_limit_fallback_total", "Redis → in-memory rate limit fallbacks", 0);
inc("export_completed_total", "Exports completed", 0);
inc("export_failed_total", "Export jobs failed", 0);
// v2.38.1 (ревью F9): реклейм застрявших running-экспортов (воркер, TTL 10 мин)
inc("export_reclaimed_total", "Export jobs reclaimed from stuck running", 0);
inc("retention_runs_total", "Retention cron runs", 0);
inc("session_delete_total", "Session soft-deletes", 0);
inc("trip_delete_total", "Trip deletes (user request)", 0); // v2.30.0: DELETE /api/trips/[id]
inc("audit_log_total", "Audit log entries", 0);
// v2.38.2 (ревью F52): телеметрия квоты D1. Шлюз (d1-gateway.js) возвращает
// meta.rows_read/rows_written с каждым /query и результатом /batch; db-d1.ts
// агрегирует их сюда. Счётчики пер-процессные (in-memory, как весь реестр:
// рестарт обнуляет — rate() в Grafana строится по приросту). Дневной бюджет
// free-тира D1 = 5 млн строк чтения (инцидент 16.09.2026 — OPERATIONS.md §5а);
// экспорт этих счётчиков делает расход наблюдаемым (алерт на дневной лимит —
// задача дашборда, значение уже не теряется).
export const D1_ROWS_READ_TOTAL = "d1_rows_read_total";
export const D1_ROWS_WRITTEN_TOTAL = "d1_rows_written_total";
inc(D1_ROWS_READ_TOTAL, "D1 rows read (gateway meta, cumulative per process)", 0);
inc(D1_ROWS_WRITTEN_TOTAL, "D1 rows written (gateway meta, cumulative per process)", 0);
