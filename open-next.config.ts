// open-next.config.ts — конфиг OpenNext для Cloudflare (§B6 v2.40.0,
// docs/OPTIMIZATION-PROPOSAL.md Вариант B, п.6 «весь сайт на Cloudflare»).
// Инкрементальный кэш/теги НЕ настраиваем: приложение не использует ISR
// (все страницы/dashboard — динамические SSR + клиентский опрос; статику
// раздают Workers Static Assets). Дефолтные overrides отсутствуют — воркер
// не требует ни KV, ни R2, ни Durable Objects биндингов для кэша.
//
// buildCommand: ОБЁРТКА cf-proxy-swap — на время next build подменяет
// src/proxy.ts (Node-runtime, конвенция Next 16) на src/middleware.ts
// (Edge-двойник src/proxy.workers.ts): OpenNext Cloudflare не поддерживает
// Node-Middleware (каждый запрос 500 «Promise.prototype.then … incompatible
// receiver»), Edge-runtime достижим только middleware.ts-конвенцией.
// Восстановление дерева — гарантировано (finally внутри скрипта).
import { defineCloudflareConfig } from "@opennextjs/cloudflare/config";

const base = defineCloudflareConfig({
  // routePreloadingBehavior по умолчанию "none" — минимальный CPU на холодном
  // старте (важно на free-плане Workers: 10 мс CPU/инвокация).
});

export default {
  ...base,
  // Свап прокси → edge-middleware только на время next build (см. шапку).
  buildCommand: "node scripts/cf-proxy-swap.mjs -- npm run build",
};
