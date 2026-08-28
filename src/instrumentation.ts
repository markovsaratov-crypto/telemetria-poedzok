// src/instrumentation.ts — Next.js 16 instrumentation hook.
// Starts in-process worker at runtime (not during build).
export async function register(): Promise<void> {
  if (typeof process === "undefined" || !process.versions?.node) return;
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
