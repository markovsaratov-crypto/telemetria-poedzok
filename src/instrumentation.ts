// src/instrumentation.ts — Next.js 16 official instrumentation hook.
//
// Этот файл Next.js автоматически вызывает при старте сервера (один раз),
// ДО того как начнёт обрабатывать HTTP-запросы. Используется для запуска
// background-задач, которые должны жить всё время жизни процесса.
//
// Здесь мы запускаем in-process Worker runtime, который поллит TrafficJob
// каждые 5 секунд и обрабатывает их через route chain (2ГИС → OSRM → haversine).
//
// Решение "без костылей":
//   - Render Free tier: 1 web-сервис → worker живёт ВНУТРИ Next.js.
//   - Не требует отдельного порта (3001) или CRON_SECRET.
//   - Идемпотентно: HMR в dev не создаёт дубликаты (guard через globalThis).
//   - Автоматически рестартует при redeploy Render (т.к. это часть Next.js).
//
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register(): Promise<void> {
  // Only in Node.js runtime — НЕ в Edge Runtime (который Next.js использует для
  // некоторых instrumentation contexts). Проверяем через typeof process и
  // наличие process.versions.node.
  if (typeof process === "undefined" || !process.versions?.node) return;

  // Пропускаем в режиме сборки (next build) — там register тоже вызывается,
  // но нам не нужно запускать worker во время билда.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Lazy import чтобы не тащить worker-runtime в client bundle
  const { startWorkerRuntime } = await import("./lib/worker-runtime");

  try {
    startWorkerRuntime();
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        msg: "instrumentation.register: worker runtime started",
      })
    );
  } catch (err) {
    // Не роняем сервер, если worker не смог стартовать (например, БД недоступна).
    // Worker имеет internal retry в poll loop — на следующей итерации попробует снова.
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "error",
        msg: "instrumentation.register: failed to start worker runtime",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
