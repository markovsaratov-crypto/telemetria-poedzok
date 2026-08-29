// sw.js — v2.9.8: минимальный service worker для installable PWA.
// Стратегии:
//  - статика Next.js (/_next/static/*): cache-first (иммутаемые хэшированные ассеты)
//  - иконки приложения (/icons/*): cache-first
//  - навигация (страницы): network-first, офлайн-fallback на кэш
//  - всё остальное (API, тайлы карт): только сеть — телеметрия всегда свежая,
//    тайлы Leaflet не раздуваем кэш (CARTO/Esri отдают своё кэширование)
const VERSION = "telem-v2.9.8";
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
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

  // навигация — network-first с офлайн-фолбэком на кэш
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGES_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
  }
});
