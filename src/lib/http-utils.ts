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
  //
  // v2.38.2 (ревью F27, partial): 'unsafe-eval' удалён — в коде нет ни eval,
  // ни new Function (проверено ревью), прод-бандлу он не нужен. Добавлены
  // object-src 'none' (плагины/<object>) и base-uri 'self' (анти-<base href>
  // инъекция). 'unsafe-inline' в script-src ОСТАЁТСЯ осознанно (honest trade-off):
  // Next.js App Router гидрируется инлайн-скриптами (self.__next_f.push с RSC-
  // payload), которые не имеют nonce — полноценный nonce-CSP требует прокидывать
  // nonce в request-headers в src/proxy.ts (вне зоны этого фикса) и перестройки
  // гидрации; честно фиксируем: XSS-фильтрация по CSP сегодня частичная,
  // основной барьер — React-escaping + nosniff. Полный план — ревью F27.
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com",
      "font-src 'self' https://fonts.gstatic.com",
      "object-src 'none'",
      "base-uri 'self'",
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
  // v2.38.2 (ревью F35): фолбэки на x-real-ip / x-client-ip УДАЛЕНЫ — оба
  // заголовка ставит (или подделывает) сам КЛИЕНТ: при отсутствии XFF лимиты
  // ключились бы по полностью контролируемому отправителем значению —
  // синтетические уникальные IP = обход rate-limit. Без XFF честный
  // консервативный ответ "unknown" (общий бакет: fail-closed для лимитов,
  // спуфинг невозможен). Доверенный x-real-ip требует списка прокси в конфиге —
  // такого списка нет, поэтому заголовок не используется вовсе.
  return "unknown";
}

// v2.38.2 (ревью F31): маскировка PII в логах. Email/IP пользователей —
// персональные данные (GDPR-линза ревью): в JSON-логах Render адреса неудачных
// логинов и IP регистраций остаются навсегда. Логи НЕ удаляем (разбор
// brute-force-инцидентов важнее), но пишем замаскированными.

// Email → «a***@d***.ru»: локальная часть и домен по 1-му символу + tld.
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "…";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const dom = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}***@${dom.slice(0, 1)}***${tld}`;
}

// IP → «203.0.113.x» (IPv4, /24 достаточно для разбора инцидентов) или
// усечённый префикс для IPv6/прочего.
export function maskIp(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const o = ip.split(".");
    return `${o[0]}.${o[1]}.${o[2]}.x`;
  }
  return ip.length > 12 ? `${ip.slice(0, 8)}…` : ip;
}
