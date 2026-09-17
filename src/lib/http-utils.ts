// src/lib/http-utils.ts — CORS, security headers, JSON responses (§6.4, §6.5)
import { NextRequest, NextResponse } from "next/server";
import { env } from "./env"; // v2.38.1 (ревью F10): TRUSTED_PROXY_COUNT для getClientIP

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  // P1-8: 204 не допускает тела — Next.js Response конструктор падал
  // («Invalid response status code 204»), превращая успешный DELETE в 500.
  if (status === 204) {
    const h = new Headers(headers);
    h.set("X-Body-Empty", "1");
    // v2.38.1 (ревью F12): no-store и для 204 (тело пустое, но ответ приватный)
    if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
    return new NextResponse(null, { status: 204, headers: h });
  }
  return NextResponse.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // v2.38.1 (ревью F12): ВСЕ API-ответы приватные или токен-скопированные
      // (/api/auth/me, /api/stats, сессии с GPS-треками, /api/share?token=…) —
      // по умолчанию запрет кэширования, иначе приватные GET могут осесть в
      // кэше CDN (TurboFlare) после включённого кэширования JSON/200.
      // Раньше doc-заявка «no-store у всех API» (CUSTOM_DOMAIN.md §57) была
      // ложью: заголовок ставил только /api/metrics. Явный Cache-Control в
      // headers переопределяет дефолт (единственное исключение сегодня —
      // speed-record: «private, max-age=300» для общего кэша скорости).
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

// AUDIT B-15: preflight отражает ТОЛЬКО собственный origin приложения.
// Раньше отражался произвольный Origin + Allow-Credentials — опасная конфигурация.
export function corsResponse(request: NextRequest) {
  const origin = request.headers.get("origin");
  const sameOrigin = !!origin && origin === new URL(request.url).origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Client-Id, X-Request-Id",
    "Access-Control-Max-Age": "86400",
  };
  if (sameOrigin) {
    headers["Access-Control-Allow-Origin"] = origin as string;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return new NextResponse(null, { status: 204, headers });
}

export function setSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // R5.5: geolocation=(self) — needed for the device GPS capture flow on /m;
  // camera/microphone/payment explicitly disabled. Updated from `geolocation=()`.
  response.headers.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=()");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  // R5.5: Content-Security-Policy — relaxed enough for Leaflet tile servers
  // (OSM, OpenTopoMap, Esri ArcGIS) and Google Fonts, strict on everything
  // else. frame-ancestors 'none' = clickjacking hard-block.
  // v2.29.0: *.cartocdn.com удалён — CARTO-тайлы больше не используются
  // (провайдер требует API-ключ с авг 2026).
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com",
      "font-src 'self' https://fonts.gstatic.com",
      "frame-ancestors 'none'",
    ].join("; ")
  );
}

// Извлечение client IP (за Caddy/nginx/TurboFlare/Render прокси).
// v2.38.1 (ревью F10): ПОСЛЕДНЯЯ запись X-Forwarded-For корректна только для
// ОДНОГО доверенного прокси. Прод-цепочка может быть длиннее: клиент →
// TurboFlare (CDN) → Render — Render аппендит IP edge-ноды CDN, и тогда все
// клиенты одной edge-ноды делят ОДИН rate-limit-бакет (login-DoS, общий
// ingest-бакет). Теперь идём по XFF СПРАВА НАЛЕВО: суффикс из
// TRUSTED_PROXY_COUNT записей дописан доверенными прокси (каждый аппендит IP
// своего peer), реальный клиент — первый элемент этого суффикса:
// parts[parts.length - TRUSTED_PROXY_COUNT].
//   TRUSTED_PROXY_COUNT=1 (дефолт, прямой Render): parts[n-1] = последняя
//     запись — как в AUDIT B-9, поведение не меняется;
//   TRUSTED_PROXY_COUNT=2 (клиент → TurboFlare → Render): parts[n-2] =
//     предпоследняя запись — реальный клиент (последняя = IP edge-ноды CDN).
// AUDIT B-9 (спуфинг): записи ЛЕВЕЕ доверенного суффикса контролирует сам
// клиент — формула их не использует; при более КОРОТКОМ XFF, чем заявлено
// прокси, клампимся к parts[0] (не хуже прежнего поведения «последняя запись»).
export function getClientIP(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      // v2.38.1 (ревью F10): пропуск TRUSTED_PROXY_COUNT доверенных записей справа
      const trusted = env().TRUSTED_PROXY_COUNT;
      const idx = Math.max(0, parts.length - trusted);
      return parts[idx];
    }
  }
  const xreal = request.headers.get("x-real-ip");
  if (xreal) return xreal;
  return request.headers.get("x-client-ip") || "unknown";
}
