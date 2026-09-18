// src/proxy.workers.ts — §B6 v2.40.0: EDGE-двойник src/proxy.ts ТОЛЬКО для
// сборки под Cloudflare Workers (@opennextjs/cloudflare).
//
// ПОЧЕМУ ДВА ФАЙЛА: Next.js 16 жёстко компилирует конвенцию `proxy.ts` в
// Node.js runtime («The proxy runtime is nodejs, and it cannot be
// configured», апгрейд-гайд 15→16), а OpenNext Cloudflare Node-Middleware
// НЕ поддерживает вообще (https://opennext.js.org/cloudflare — supported
// features): любой запрос к воркеру падает 500
// «TypeError: Method Promise.prototype.then called on incompatible
// receiver #<Promise>» — capability gap, не ошибка логики. Единственный путь
// обратно в Edge-runtime — ДО-Next16 конвенция `middleware.ts` с именованным
// экспортом `middleware`. Поэтому scripts/cf-proxy-swap.mjs на время CF-сборки
// прячет proxy.ts и подставляет ЭТОТ файл как src/middleware.ts; сборка
// Render/Docker/CI по-прежнему использует src/proxy.ts (Node, полная версия).
//
// РАЗЛИЧИЕ с proxy.ts (единственное): гейт /api/ingest. В Node-прокси он
// зовёт resolveIngestToken (auth.ts → userDb → БД) для всех трёх каналов
// (глобальный INGEST_TOKEN / производный it_-токен / сырой apiKey). Edge-
// изолят БД не видит — поэтому здесь: глобальный INGEST_TOKEN проверяется
// timing-SAFE полностью (tokenMatches, crypto.subtle), а it_/apiKey-токены
// проходят ПАТТЕРН-гейт и авторитетно проверяются самим роутом
// /api/ingest (resolveIngestToken там вызывается ОБЯЗАТЕЛЬНО — defense-in-
// depth с v2.16.0 V9, «один регресс матчера — и роут без своей проверки
// писал бы данные по любому запросу»). Безопасность не ослаблена: value-
// проверка всех каналов остаётся в роуте, middleware — лишь быстрый pre-гейт.
//
// Всё остальное — 1:1 с proxy.ts (модули edge-safe by design: rate-limit,
// env, http-utils, logger, metrics, token-check, cookie-name — Web APIs only).
import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, rlKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { corsResponse, setSecurityHeaders, json, getClientIP } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { tokenMatches, INGEST_TOKEN_RE } from "@/lib/token-check";
import { sessionCookieName } from "@/lib/cookie-name";

const SESSION_COOKIE_NAME = sessionCookieName();

const PUBLIC_PATHS = ["/api/keepalive", "/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/auth/me", "/health", "/api/metrics", "/api/share"];
const SESSION_STATS_RE = /^\/api\/sessions\/[^/]+\/stats$/;
const SESSION_EVENTS_RE = /^\/api\/sessions\/[^/]+\/events$/;
const SESSION_TRACK_RE = /^\/api\/sessions\/[^/]+\/track$/;
const ADMIN_PATHS = ["/api/admin/"];
const WORKER_PATHS = ["/api/worker/"];

// Сырой per-user apiKey (Bearer-канал роута): 32–128 hex — паттерн-гейт,
// ЗНАЧЕНИЕ проверит роут (userDb.findByApiKey).
const RAW_API_KEY_RE = /^[0-9a-f]{32,128}$/;

function rateLimitForPath(pathname: string, method: string): { limit: number; windowSec: number; scope: string } {
  const e = env();
  if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/")) return { limit: e.RATE_LIMIT_MAX_INGEST, windowSec: 60, scope: "ingest" };
  if (pathname === "/api/auth/login") return { limit: e.RATE_LIMIT_MAX_AUTH, windowSec: 60, scope: "auth:login" };
  if (
    ((pathname === "/api/admin/backup" || pathname.startsWith("/api/admin/backup/") || pathname === "/api/admin/restore" || pathname === "/api/admin/backfill-trips") &&
      method !== "GET")
  ) {
    return { limit: e.RATE_LIMIT_MAX_ADMIN, windowSec: 3600, scope: "admin:heavy" };
  }
  if (pathname === "/api/admin/requeue") return { limit: e.RATE_LIMIT_MAX_REQUEUE, windowSec: 60, scope: "admin:requeue" };
  if (
    (method === "GET" &&
      (pathname === "/api/sessions" ||
        SESSION_STATS_RE.test(pathname) ||
        SESSION_EVENTS_RE.test(pathname) ||
        SESSION_TRACK_RE.test(pathname) ||
        pathname === "/api/stats/batch" ||
        pathname === "/api/events/batch" ||
        pathname === "/api/track/batch" ||
        pathname === "/api/geocode/reverse" ||
        pathname === "/api/trips" ||
        pathname === "/api/trips/batch" ||
        /^\/api\/trips\/[A-Za-z0-9_-]{1,64}$/.test(pathname))) ||
    (method === "POST" && pathname === "/api/sessions/batch")
  ) {
    return { limit: e.RATE_LIMIT_MAX_READ, windowSec: 60, scope: "read" };
  }
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
  if (scope === "admin:heavy" || scope === "admin:requeue") {
    const auth = request.headers.get("authorization") || "";
    const bearer = bearerToken(auth);
    if (bearer) {
      // v2.40.3 (ревью 19-j, C-1): ключ = токен + ПУТЬ (симметрично src/proxy.ts):
      // cron-бэкап 03:30 и backup-github 04:00 делят CRON_SECRET — общий бакет
      // admin:heavy 1/час давал 429 воскресному GitHub-бэкапу.
      return rlKey(scope, bearer.slice(0, 16), new URL(request.url).pathname);
    }
    return rlKey(scope, "ip", getClientIP(request));
  }
  return rlKey(scope, ip);
}

function bearerToken(auth: string): string | null {
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function routeLabel(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) =>
      !seg || seg.length <= 16 ? seg : /^[0-9a-f-]+$/i.test(seg) ? ":id" : ":param"
    )
    .join("/");
}

// Имя `middleware` (не `proxy`) — ДО-Next16 конвенция src/middleware.ts,
// которую свап-скрипт создаёт из этого файла для CF-сборки; OpenNext
// поддерживает именно Edge-middleware.
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  const pathname = request.nextUrl.pathname;

  try {
    // 0. payload-size guard (preчек по content-length; реальную длину тела
    // проверяют роуты-получатели — payload-limit.ts, ревью F20)
    const isLargeUpload = pathname === "/api/import/zip" || pathname === "/api/import/csv";
    const clRaw = request.headers.get("content-length");
    const cl = clRaw != null && clRaw.trim() !== "" && Number.isFinite(Number(clRaw)) ? Number(clRaw) : null;
    const maxBytes = isLargeUpload ? 100 * 1024 * 1024 : env().MAX_PAYLOAD_BYTES;
    if (cl != null && cl > maxBytes) {
      return json({ error: "Payload too large", limit: maxBytes }, 413, { "X-Request-Id": requestId });
    }

    // 1. CORS preflight
    if (request.method === "OPTIONS") {
      const r = corsResponse(request);
      r.headers.set("X-Request-Id", requestId);
      return r;
    }

    // 2. Rate limit
    const rl = rateLimitForPath(pathname, request.method);
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

    // 3. Auth (кроме public)
    const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!isPublic && pathname.startsWith("/api/")) {
      const authHeader = request.headers.get("authorization") || "";
      const cookie = request.headers.get("cookie") || "";
      const queryToken = request.nextUrl.searchParams.get("token") || "";
      const bearer = bearerToken(authHeader);
      const hasCookie = cookie.includes(SESSION_COOKIE_NAME);
      const e = env();

      if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/")) {
        // EDGE-ГЕЙТ (см. шапку файла): глобальный INGEST_TOKEN — timing-safe
        // value-check; it_/apiKey — паттерн-гейт, ЗНАЧЕНИЕ проверит роут.
        const token = bearer ?? (queryToken || null);
        const isGlobal = token ? await tokenMatches(token, e.INGEST_TOKEN) : false;
        const isPersonalShaped =
          token != null && (INGEST_TOKEN_RE.test(token) || RAW_API_KEY_RE.test(token));
        if (!isGlobal && !isPersonalShaped) {
          inc("ingest_unauthorized_total", "Ingest attempts rejected with 401 (bad or missing token)", 1, "ingest");
          return json({ error: "Unauthorized", reason: "edge-gate: ingest token required" }, 401, { "X-Request-Id": requestId });
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
        const isCronBackupPost =
          request.method === "POST" &&
          (pathname === "/api/admin/backup" || pathname === "/api/admin/backup/github");
        if (bearer) {
          const isAdmin = await tokenMatches(bearer, e.ADMIN_TOKEN);
          const isCronBackup = isCronBackupPost && (await tokenMatches(bearer, e.CRON_SECRET));
          if (!isAdmin && !isCronBackup) {
            return json({ error: "Unauthorized", reason: "Invalid ADMIN_TOKEN" }, 401, { "X-Request-Id": requestId });
          }
        } else if (!hasCookie) {
          return json({ error: "Unauthorized", reason: "ADMIN_TOKEN or cookie required" }, 401, { "X-Request-Id": requestId });
        }
      } else {
        if (!bearer && !hasCookie) {
          return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
        }
      }
    }

    // 4. Security headers + requestId (+ x-start-epoch-ms для trackLatency)
    let response: NextResponse;
    if (pathname.startsWith("/api/")) {
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("x-start-epoch-ms", String(Date.now()));
      response = NextResponse.next({ request: { headers: forwardHeaders } });
    } else {
      response = NextResponse.next();
    }
    setSecurityHeaders(response);
    response.headers.set("X-Request-Id", requestId);

    inc("http_requests_total", "Total HTTP requests", 1, routeLabel(pathname));
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
