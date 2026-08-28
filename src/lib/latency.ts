// src/lib/latency.ts — P2-16: кольцевой буфер длительностей API-запросов (Node-изолят).
// Middleware (edge-изолят) прокидывает время старта запроса в заголовке
// x-start-epoch-ms (см. src/middleware.ts); роуты вызывают trackLatency(request)
// после формирования ответа. Покрытие — основные API-роуты (ingest, sessions,
// stats, batch-stats, speed-distribution, metrics); ограничение документировано
// в docs/OPERATIONS.md (правило api_latency_p95, §14.4 спеки).

const WINDOW_MS = 5 * 60 * 1000; // 5 минут — окно правила §14.4
const MAX_SAMPLES = 2000;

interface Sample {
  t: number;
  ms: number;
}

const GLOBAL_KEY = "__telemetriaLatencyWindow";
const g = globalThis as unknown as { [GLOBAL_KEY]?: Sample[] };

function window(): Sample[] {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = [];
  return g[GLOBAL_KEY]!;
}

function trim(now: number) {
  const w = window();
  while (w.length > 0 && now - w[0].t > WINDOW_MS) w.shift();
  while (w.length > MAX_SAMPLES) w.shift();
}

/** Записать длительность запроса (мс). */
export function recordLatency(ms: number) {
  const now = Date.now();
  if (!Number.isFinite(ms) || ms < 0 || ms > 10 * 60 * 1000) return;
  const w = window();
  w.push({ t: now, ms });
  trim(now);
}

/**
 * Извлечь время старта из заголовка x-start-epoch-ms (прокинут middleware)
 * и записать длительность. Вызывать перед возвратом ответа из роута.
 */
export function trackLatency(request: Request) {
  const start = Number(request.headers.get("x-start-epoch-ms"));
  if (Number.isFinite(start) && start > 0) recordLatency(Date.now() - start);
}

/** p95 по выборке за окно; при < 10 выборок возвращает null (мало данных). */
export function latencyP95Ms(): { p95: number | null; samples: number } {
  const now = Date.now();
  trim(now);
  const w = window();
  if (w.length < 10) return { p95: null, samples: w.length };
  const sorted = w.map((s) => s.ms).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return { p95: sorted[idx], samples: sorted.length };
}
