// src/lib/http-utils.ts — CORS, security headers, JSON responses (§6.4, §6.5)
import { NextRequest, NextResponse } from "next/server";

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  // P1-8: 204 не допускает тела — Next.js Response конструктор падал
  // («Invalid response status code 204»), превращая успешный DELETE в 500.
  if (status === 204) {
    const h = new Headers(headers);
    h.set("X-Body-Empty", "1");
    return new NextResponse(null, { status: 204, headers: h });
  }
  return NextResponse.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
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
  // (OSM, OpenTopoMap, Esri ArcGIS, CartoDB) and Google Fonts, strict on
  // everything else. frame-ancestors 'none' = clickjacking hard-block.
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com https://*.cartocdn.com",
      "font-src 'self' https://fonts.gstatic.com",
      "frame-ancestors 'none'",
    ].join("; ")
  );
}

// Извлечение client IP (за Caddy/nginx/Render прокси).
// AUDIT B-9: берём ПОСЛЕДНЮЮ запись X-Forwarded-For — её добавил ближайший
// доверенный прокси. Первую запись легко подделать (спуфинг для обхода rate-limit).
export function getClientIP(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const xreal = request.headers.get("x-real-ip");
  if (xreal) return xreal;
  return request.headers.get("x-client-ip") || "unknown";
}
