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
inc("traffic_job_failed_total", "Traffic jobs failed", 0);
inc("routing_fallback_total", "Routing provider fallbacks", 0);
inc("rate_limit_fallback_total", "Redis → in-memory rate limit fallbacks", 0);
inc("export_completed_total", "Exports completed", 0);
inc("export_failed_total", "Export jobs failed", 0);
inc("retention_runs_total", "Retention cron runs", 0);
inc("session_delete_total", "Session soft-deletes", 0);
inc("audit_log_total", "Audit log entries", 0);
