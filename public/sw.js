// sw.js — v2.9.9: service worker для installable PWA.
// Стратегии:
//  - статика Next.js (/_next/static/*): cache-first (иммутаемые хэшированные ассеты)
//  - иконки приложения (/icons/*): cache-first
//  - навигация (страницы): network-first, офлайн-fallback на кэш, затем /offline.html
//  - всё остальное (API, тайлы карт): только сеть — телеметрия всегда свежая,
//    тайлы Leaflet не раздуваем кэш (CARTO/Esri отдают своё кэширование)
//
// v2.9.9: управляемое обновление вместо мгновенного skipWaiting:
//  - install БЕЗ skipWaiting → новый SW уходит в waiting
//  - страница ловит waiting через useSwUpdate() → баннер «Доступна новая версия»
//  - клик «Обновить» → postMessage SKIP_WAITING → activate → страница перезагружается
//  (в v2.9.8 skipWaiting срабатывал сразу: старая вкладка оставалась на устаревшем
//   бандле до ручной перезагрузки — «browser hangs on old tab»)
const VERSION = "telem-v2.9.9";
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
    // v2.9.9: без skipWaiting — обновление применяется по подтверждению пользователя
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

// v2.9.9: подтверждённое обновление — страница шлёт SKIP_WAITING,
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

  // навигация — network-first: сеть → кэш → офлайн-заглушка со статистикой
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGES_CACHE).then((c) => c.put(req, copy));
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
