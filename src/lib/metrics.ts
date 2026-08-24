// src/lib/metrics.ts — Prometheus-style метрики (in-memory, без prom-client dep, §7.2)
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

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();

export function inc(name: string, help = "", by = 1, label?: string) {
  let c = counters.get(name);
  if (!c) {
    c = { name, help, value: 0, labels: new Map() };
    counters.set(name, c);
  }
  c.value += by;
  if (label) {
    c.labels.set(label, (c.labels.get(label) || 0) + by);
  }
}

export function set(name: string, value: number, help = "") {
  let g = gauges.get(name);
  if (!g) {
    g = { name, help, value };
    gauges.set(name, g);
  }
  g.value = value;
}

export function metricsText(): string {
  const lines: string[] = [];
  for (const c of counters.values()) {
    if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    lines.push(`${c.name} ${c.value}`);
    for (const [label, val] of c.labels.entries()) {
      lines.push(`${c.name}{${label}} ${val}`);
    }
  }
  for (const g of gauges.values()) {
    if (g.help) lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    lines.push(`${g.name} ${g.value}`);
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
inc("audit_log_total", "Audit log entries", 0);
