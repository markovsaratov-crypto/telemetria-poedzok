// src/instrumentation.ts — Next.js 16 instrumentation hook.
// Starts in-process worker at runtime (not during build).
//
// v2.9.10 (P0-фикс Render build failure): Turbopack хардкодит Edge-вариант
// instrumentation.ts (см. node_modules/next/dist/build/swc/index.js —
// napiInstrumentationToInstrumentation возвращает {nodeJs, edge}). Даже если
// в проекте нет Edge-роутов (proxy.ts теперь Node.js-only по умолчанию в
// Next.js 16), Turbopack всё равно собирает Edge-бандл instrumentation.ts.
// Поэтому весь транзитивный импорт (worker-runtime → settings → db) должен
// быть Edge-safe. Этот файл использует только `process.env` (Edge-safe
// полифил Next.js) — никаких `process.versions`, `process.on`, `import crypto`.
//
// NEXT_RUNTIME — env-переменная, которую Next.js устанавливает при сборке:
// "nodejs" или "edge". Доступна в обоих runtime через process.env polyfill.
export async function register(): Promise<void> {
  // Guard: выполнять ТОЛЬКО в Node.js runtime (не Edge, не build-phase).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (!process.env.DATABASE_URL) return;
  // v2.40.4 (ревью RR-2 / CR-1 хвост): РОЛЕВОЙ ГЕЙТ инстанса.
  // OpenNext-канарейка на CF Workers тоже проходит гейты выше (NEXT_RUNTIME
  // "nodejs" эмулируется, DATABASE_URL есть) — и на КАЖДОМ изоляте стартовал
  // воркер + warmup + corpus-sweep. При эвикциях каждые ~13-15 мин это
  // «рестарт-бёрн» ~0,4-0,6 млн строк чтений D1/час (главный жгут квоты).
  // Теперь фоновые контуры (воркер/warmup) живут ТОЛЬКО на долгоживущем
  // Render-инстансе; канарейка — stateless читатель. Определение runtime:
  // в workerd navigator.userAgent === "Cloudflare-Workers" (nodejs_compat),
  // в реальном Node.js — "Node.js/<версия>". Ложных срабатываний нет.
  // Escape-hatch: WORKER_FORCE=1 в vars воркера возвращает прежнее поведение.
  const onCloudflareWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  // Настройки — лёгкое чтение (одна строка Setting): нужны и читающему
  // канарейному изоляту. Выносено ДО гейта (раньше шло после старта воркера).
  try {
    const { ensureSettingsLoaded } = await import("./lib/settings");
    try { await ensureSettingsLoaded(); } catch {}
  } catch {}
  if (onCloudflareWorkers && process.env.WORKER_FORCE !== "1") {
    console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "worker runtime+warmup skipped: Cloudflare canary isolate (role gate CR-1/RR-2)" }));
    return;
  }
  try {
    const { startWorkerRuntime } = await import("./lib/worker-runtime");
    startWorkerRuntime();
    console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "worker runtime started" }));
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", msg: "worker start failed", error: err instanceof Error ? err.message : String(err) }));
  }
  // v2.39.0 (§A4, docs/OPTIMIZATION-PROPOSAL.md): бюджетный прогрев после
  // старта — top-20 сессий/поездок + rollup 7 дней + ensure StatsRollup DDL.
  // Fire-and-forget: любые ошибки глотаются ВНУТРИ (при исчерпанной квоте D1
  // прогрев тихо деградирует — старт не место для падений).
  // v2.40.4: НЕ выполняется на CF-канарейке (рестарт-бёрн, гейт выше).
  try {
    const { runStartupWarmup } = await import("./lib/warmup");
    void runStartupWarmup().catch(() => {});
  } catch {
    // сам импорт упал (битый бандл) — молча: прогрев опционален
  }
}
