// src/lib/http-utils.ts — CORS, security headers, JSON responses (§6.4, §6.5)
import { NextRequest, NextResponse } from "next/server";

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function corsResponse(request: NextRequest) {
  const origin = request.headers.get("origin") || "*";
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-Client-Id, X-Request-Id",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function setSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  // CSP: разрешаем self + inline styles (Tailwind) + leaflet CDN при необходимости
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://unpkg.com",
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
      "connect-src 'self' https://router.project-osrm.org https://*.2gis.ru",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
    ].join("; ")
  );
}

// Извлечение client IP (за Caddy/nginx прокси)
export function getClientIP(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xreal = request.headers.get("x-real-ip");
  if (xreal) return xreal;
  return request.headers.get("x-client-ip") || "unknown";
}
