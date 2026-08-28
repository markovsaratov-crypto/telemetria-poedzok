// src/middleware.ts — сквозная обработка: payload guard, CORS, rate-limit, auth, security headers, requestId (§2.4)
import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, rlKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { corsResponse, setSecurityHeaders, json, getClientIP } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { tokenMatches } from "@/lib/token-check"; // P0-3: проверка ЗНАЧЕНИЙ токенов
import { sessionCookieName } from "@/lib/cookie-name"; // P0-5: __Host- префикс в prod

// В dev-режиме cookie без __Host- префикса (который требует Secure).
const SESSION_COOKIE_NAME = sessionCookieName();

// Эндпоинты без авторизации
const PUBLIC_PATHS = ["/api/keepalive", "/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/auth/me", "/health", "/api/metrics"];
const ADMIN_PATHS = ["/api/admin/"];
const WORKER_PATHS = ["/api/worker/"];

function rateLimitForPath(pathname: string): { limit: number; windowSec: number; scope: string } {
  const e = env();
  if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/")) return { limit: e.RATE_LIMIT_MAX_INGEST, windowSec: 60, scope: "ingest" };
  if (pathname === "/api/auth/login") return { limit: e.RATE_LIMIT_MAX_AUTH, windowSec: 60, scope: "auth:login" };
  if (pathname === "/api/plan") return { limit: e.RATE_LIMIT_MAX_PLAN, windowSec: 60, scope: "plan" };
  if (pathname === "/api/admin/backup" || pathname === "/api/admin/restore") return { limit: e.RATE_LIMIT_MAX_ADMIN, windowSec: 3600, scope: "admin:heavy" };
  if (pathname === "/api/audit") return { limit: e.RATE_LIMIT_MAX_AUDIT, windowSec: 60, scope: "audit" };
  if (pathname.startsWith("/api/")) return { limit: e.RATE_LIMIT_MAX_DEFAULT, windowSec: 60, scope: "default" };
  return { limit: 0, windowSec: 60, scope: "none" };
}

function rateLimitKey(scope: string, request: NextRequest): string {
  const ip = getClientIP(request);
  if (scope === "ingest") {
    const auth = request.headers.get("authorization") || "no-token";
    const tokenPart = auth.replace(/^Bearer\s+/i, "").slice(0, 16);
    return rlKey(scope, ip, tokenPart);
  }
  if (scope === "auth:login") {
    return rlKey(scope, ip);
  }
  if (scope === "plan" || scope === "audit" || scope === "admin:heavy") {
    const auth = request.headers.get("authorization") || "no-token";
    const tokenPart = auth.replace(/^Bearer\s+/i, "").slice(0, 16);
    return rlKey(scope, tokenPart);
  }
  return rlKey(scope, ip);
}

function bearerToken(auth: string): string | null {
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  const pathname = request.nextUrl.pathname;

  try {
    // 0. payload-size guard (до чтения body, §2.4)
    // Skip for ZIP imports (large files expected)
    const isZipImport = pathname === "/api/import/zip";
    const cl = Number(request.headers.get("content-length") ?? 0);
    const maxBytes = isZipImport ? 100 * 1024 * 1024 : env().MAX_PAYLOAD_BYTES; // 100MB for ZIP, 256KB default
    if (cl > maxBytes) {
      return json({ error: "Payload too large", limit: maxBytes }, 413, { "X-Request-Id": requestId });
    }

    // 1. CORS preflight
    if (request.method === "OPTIONS") {
      const r = corsResponse(request);
      r.headers.set("X-Request-Id", requestId);
      return r;
    }

    // 2. Rate limit (sliding window, in-memory в sandbox)
    const rl = rateLimitForPath(pathname);
    if (rl.limit > 0) {
      const limiter = createRateLimiter();
      const key = rateLimitKey(rl.scope, request);
      const result = await limiter.check(key, rl.limit, rl.windowSec);
      if (!result.allowed) {
        inc("rate_limit_exceeded_total", "Rate limit rejections", 1, rl.scope);
        return json(
          { error: "Rate limit exceeded", retryAfter: result.retryAfter },
          429,
          {
            "X-Request-Id": requestId,
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": String(result.remaining),
            "X-RateLimit-Reset": String(result.reset),
            "Retry-After": String(result.retryAfter),
          }
        );
      }
    }

    // 3. Auth (кроме public) — P0-3: обязательна проверка ЗНАЧЕНИЙ токенов (timing-safe),
    // а не только формата: ранее любой Bearer ≥32 символов проходил гейт.
    const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!isPublic && pathname.startsWith("/api/")) {
      const authHeader = request.headers.get("authorization") || "";
      const cookie = request.headers.get("cookie") || "";
      // ?token= query param — альтернатива Bearer header для ingest/cron (SensorLogger, cron jobs)
      const queryToken = request.nextUrl.searchParams.get("token") || "";
      const bearer = bearerToken(authHeader);
      const hasCookie = cookie.includes(SESSION_COOKIE_NAME);
      const e = env();

      if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/")) {
        const token = bearer ?? queryToken;
        if (!token || !(await tokenMatches(token, e.INGEST_TOKEN))) {
          return json({ error: "Unauthorized", reason: "Valid INGEST_TOKEN required (Bearer header or ?token= query)" }, 401, { "X-Request-Id": requestId });
        }
      } else if (pathname.startsWith("/api/cron/")) {
        const token = bearer ?? queryToken;
        if (!token || !(await tokenMatches(token, e.CRON_SECRET))) {
          return json({ error: "Unauthorized", reason: "Valid CRON_SECRET required (Bearer header or ?token= query)" }, 401, { "X-Request-Id": requestId });
        }
      } else if (WORKER_PATHS.some((p) => pathname.startsWith(p))) {
        if (!bearer || !(await tokenMatches(bearer, e.CRON_SECRET))) {
          return json({ error: "Unauthorized", reason: "Valid CRON_SECRET required" }, 401, { "X-Request-Id": requestId });
        }
      } else if (ADMIN_PATHS.some((p) => pathname.startsWith(p))) {
        // Bearer — строго значение ADMIN_TOKEN; cookie — наличие здесь,
        // полная HMAC-проверка и роль на уровне роута (authorizeRequest).
        if (bearer) {
          if (!(await tokenMatches(bearer, e.ADMIN_TOKEN))) {
            return json({ error: "Unauthorized", reason: "Invalid ADMIN_TOKEN" }, 401, { "X-Request-Id": requestId });
          }
        } else if (!hasCookie) {
          return json({ error: "Unauthorized", reason: "ADMIN_TOKEN or cookie required" }, 401, { "X-Request-Id": requestId });
        }
      } else {
        // Default scope: финальная авторизация на уровне роута (authorizeRequest:
        // API_KEY, per-user apiKey, сессионная cookie) — БД недоступна в edge-middleware.
        if (!bearer && !hasCookie) {
          return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
        }
      }
    }

    // 4. Security headers + requestId
    const response = NextResponse.next();
    setSecurityHeaders(response);
    response.headers.set("X-Request-Id", requestId);

    inc("http_requests_total", "Total HTTP requests", 1, pathname);
    return response;
  } catch (err) {
    logger.error("Middleware unexpected error", {
      requestId,
      method: request.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    return json({ error: "Internal Server Error", requestId }, 500, { "X-Request-Id": requestId });
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)",
  ],
};
