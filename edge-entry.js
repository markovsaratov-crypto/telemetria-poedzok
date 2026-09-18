// edge-entry.js — §B6 v2.40.0: кастомный entry воркера сайта (обёртка над
// .open-next/worker.js). Две обязанности:
//
// 1) SERVICE BINDING D1-ШЛЮЗА: запросы к d1-gateway.markov-saratov.workers.dev
//    изнутри CF Workers НЕДОСТУПНЫ по публичному URL (workers.dev не маршрути-
//    зируется из рантайма Workers — CF «error code: 1042»). Приложение ходит
//    в D1 через HTTP-шлюз (env D1_GATEWAY_URL, код не менялся) — поэтому
//    глобальный fetch ПАТЧИТСЯ: вызовы с хостом шлюза направляются через
//    биндинг GATEWAY_SVC (тот же воркер d1-gateway, внутренний канал:
//    быстрее публичного хода и без ограничения 1042). Прочие fetch
//    (OSRM/2ГИС/GitHub/тайлы) идут как обычно. Патч идемпотентен и ставится
//    при первом запросе (env доступен только в обработчике, не в module scope).
//
// 2) Порядок: сначала патч fetch → потом делегирование OpenNext-обработчику
//    (включая experimental Node-middleware и server functions — все их fetch
//    уже идут через патч).
//
// Сборка/деплой не меняются: wrangler main = edge-entry.js (см. wrangler.jsonc).

import openNextWorker from "./.open-next/worker.js";

const GATEWAY_HOST = "d1-gateway.markov-saratov.workers.dev";
const origFetch = globalThis.fetch;

function isGatewayTarget(input) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input.toString()).host === GATEWAY_HOST;
    }
    if (input && typeof input.url === "string") {
      return new URL(input.url).host === GATEWAY_HOST;
    }
  } catch {
    // не-URL аргумент — не наш таргет
  }
  return false;
}

async function patchedFetch(input, init) {
  if (globalThis.__GATEWAY_SVC && isGatewayTarget(input)) {
    // Service binding: URL/Request передаются как есть — маршрутизация идёт
    // по биндингу, хост в URL игнорируется рантаймом.
    try {
      if (input instanceof Request) {
        return await globalThis.__GATEWAY_SVC.fetch(input, init);
      }
      const href = typeof input === "string" || input instanceof URL ? input.toString() : String(input);
      return await globalThis.__GATEWAY_SVC.fetch(href, init);
    } catch (err) {
      // сбой биндинга — фолбэк на публичный fetch (вдруг 1042 временный):
      // приложение само разрулит ошибку шлюза (фолбэк-логика на Turso/кэши)
      console.error(JSON.stringify({
        level: "error",
        msg: "GATEWAY_SVC binding fetch failed, falling back to public fetch",
        error: String((err && err.message) || err),
      }));
    }
  }
  return origFetch(input, init);
}

export default {
  async fetch(request, env, ctx) {
    if (env.GATEWAY_SVC && !globalThis.__GATEWAY_PATCHED__) {
      globalThis.__GATEWAY_SVC = env.GATEWAY_SVC;
      globalThis.fetch = patchedFetch;
      globalThis.__GATEWAY_PATCHED__ = true;
    }
    return openNextWorker.fetch(request, env, ctx);
  },
};
