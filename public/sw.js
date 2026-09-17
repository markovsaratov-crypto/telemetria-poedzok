// sw.js — v2.38.2: service worker для installable PWA.
// Стратегии:
//  - статика Next.js (/_next/static/*): cache-first (иммутаемые хэшированные ассеты)
//  - иконки приложения (/icons/*): cache-first
//  - навигация (страницы): network-first, офлайн-fallback на кэш, затем /offline.html
//  - всё остальное (API, тайлы карт): только сеть — телеметрия всегда свежая,
//    тайлы Leaflet не раздуваем кэш (Esri/OSM отдают своё кэширование)
//
// v2.9.9: управляемое обновление вместо мгновенного skipWaiting (без изменений в v2.9.10):
//  - install БЕЗ skipWaiting → новый SW уходит в waiting
//  - страница ловит waiting через useSwUpdate() → баннер «Доступна новая версия»
//  - клик «Обновить» → postMessage SKIP_WAITING → activate → страница перезагружается
//  (в v2.9.8 skipWaiting срабатывал сразу: старая вкладка оставалась на устаревшем
//   бандле до ручной перезагрузки — «browser hangs on old tab»)
// v2.38.2 · F76: версия SW синхронизирована с релизом приложения (v2.38.2;
// была telem-v2.9.10 — имена кэшей дезинформировали при отладке stale-кэша:
// байт-дифф sw.js триггерит update-флоу, а имена кэшей в activate сбрасывают
// старые записи icons/PRECACHE).
const VERSION = "telem-v2.38.2";
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", OFFLINE_URL];

// v2.38.2 · F77: PAGES_CACHE ограничен (LRU ≈ 30 записей) — каждая навигация
// (вкл. каждый /shared/<token>) раньше ложилась в кэш навсегда: неограниченный
// рост квоты. Cache.keys() возвращает записи в порядке вставки (Chromium/
// Firefox) — сверх лимита удаляем самые старые; после рестарта SW порядок
// восстанавливается из самого кэша, внешний Map-стейт не нужен.
const PAGES_CACHE_MAX = 30;

function trimPagesCache(cache) {
  return cache.keys().then((keys) => {
    const extra = keys.length - PAGES_CACHE_MAX;
    if (extra <= 0) return;
    return Promise.all(keys.slice(0, extra).map((k) => cache.delete(k)));
  });
}

// v2.38.2 · F77: таймаут на network-first fetch (8 c) — на медленной/умершей
// сети офлайн-фолбэк не ждёт полного TCP-таймаута браузера (десятки секунд),
// а сразу после AbortController-таймаута уходит в кэш → /offline.html.
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
    // v2.9.9+: без skipWaiting — обновление применяется по подтверждению пользователя
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// v2.9.9+: подтверждённое обновление — страница шлёт SKIP_WAITING,
// новый SW активируется, страница ловит controllerchange и перезагружается
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // тайлы карт и внешнее — мимо SW

  // статика Next.js и иконки — cache-first
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // навигация — network-first: сеть (с таймаутом) → кэш → офлайн-заглушка
  // v2.38.2 · F77: fetch обёрнут в 8-секундный AbortController-таймаут;
  // запись в PAGES_CACHE сопровождается LRU-тримом (≤ 30 записей).
  if (req.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(req)
        .then((res) => {
          const copy = res.clone();
          caches
            .open(PAGES_CACHE)
            .then((c) => c.put(req, copy).then(() => trimPagesCache(c)));
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || caches.match(OFFLINE_URL).then((off) => off || Response.error()))
        )
    );
  }
});
