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
  try {
    const { startWorkerRuntime } = await import("./lib/worker-runtime");
    const { ensureSettingsLoaded } = await import("./lib/settings");
    try { await ensureSettingsLoaded(); } catch {}
    startWorkerRuntime();
    console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "worker runtime started" }));
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", msg: "worker start failed", error: err instanceof Error ? err.message : String(err) }));
  }
}
