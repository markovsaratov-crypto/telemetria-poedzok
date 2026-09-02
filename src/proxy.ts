// src/proxy.ts — сквозная обработка: payload guard, CORS, rate-limit, auth, security headers, requestId (§2.4)
//
// v2.9.10 (P0-фикс Render build failure — финальная версия без костылей):
// Next.js 16 переименовал `middleware.ts` → `proxy.ts`. Proxy-файл работает в
// NODE.JS RUNTIME (Edge runtime НЕ поддерживается для proxy), тогда как
// устаревший middleware.ts работал в Edge Runtime. Это устраняет ЕДИНСТВЕННУЮ
// Edge-точку в проекте → Next.js-оптимизация (entries.js) автоматически
// удаляет Edge Instrumentation bundling → instrumentation.ts и его
// динамический import worker-runtime.ts больше НЕ бандлятся для Edge →
// исчезают ВСЕ ошибки "Node.js module is loaded which is not supported in
// the Edge Runtime" (fs, path, crypto, process.on, process.versions).
//
// Импортируемые модули (rate-limit, env, http-utils, logger, metrics,
// token-check, cookie-name) остаются edge-safe по факту (используют только
// Web APIs), но Edge-bundle теперь вообще не собирается — проверять не нужно.
//
// Названная export-функция тоже переименована: `middleware` → `proxy`
// (Next.js 16 deprecates the `middleware` named export).
// `config.matcher` остаётся в силе (только имя функции изменилось).
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
const PUBLIC_PATHS = ["/api/keepalive", "/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/auth/me", "/health", "/api/metrics", "/api/share"]; // P1-9: /api/share — публичный по спеке
// GET /api/sessions/<id>/share?token= — публичный доступ по спеке (матрица §7); P1-9
const SHARE_GET_RE = /^\/api\/sessions\/[^/]+\/share$/;
// v2.14.1: точные дешёвые GET-чтения вкладки «Поездки» (статы одной записи).
const SESSION_STATS_RE = /^\/api\/sessions\/[^/]+\/stats$/;
const ADMIN_PATHS = ["/api/admin/"];
const WORKER_PATHS = ["/api/worker/"];

function rateLimitForPath(pathname: string, method: string): { limit: number; windowSec: number; scope: string } {
  const e = env();
  if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/")) return { limit: e.RATE_LIMIT_MAX_INGEST, windowSec: 60, scope: "ingest" };
  if (pathname === "/api/auth/login") return { limit: e.RATE_LIMIT_MAX_AUTH, windowSec: 60, scope: "auth:login" };
  if (pathname === "/api/plan") return { limit: e.RATE_LIMIT_MAX_PLAN, windowSec: 60, scope: "plan" };
  // v2.10.7: «тяжёлый» лимит 1/час — только для ДОРОГИХ мутаций (POST create/restore).
  // GET /api/admin/backup — лёгкий список (SELECT), раньше попадал в тот же бакет 1/час:
  // повторное открытие вкладки админки в течение часа → 429 «Слишком много запросов»
  // (10 отказов в метриках 01.09). GET уходит в default-скоп 60/мин per-IP.
  if (
    // v2.11.0 (АУДИТ C-18): тяжёлый лимит 1/час — для ВСЕХ дорогих мутаций бэкапов:
    // POST /api/admin/backup (полный дамп) И POST /api/admin/backup/github
    // (дамп + релиз + аплоад 6 МБ) — второй раньше попадал в 60/мин default.
    (pathname === "/api/admin/backup" || pathname.startsWith("/api/admin/backup/") || pathname === "/api/admin/restore") &&
    method !== "GET"
  ) {
    return { limit: e.RATE_LIMIT_MAX_ADMIN, windowSec: 3600, scope: "admin:heavy" };
  }
  if (pathname === "/api/admin/requeue") return { limit: e.RATE_LIMIT_MAX_REQUEUE, windowSec: 60, scope: "admin:requeue" }; // P1-11: спека §7.3 — 10/мин
  if (pathname === "/api/audit") return { limit: e.RATE_LIMIT_MAX_AUDIT, windowSec: 60, scope: "audit" };
  // v2.14.1: «read»-скоп — дешёвые GET-чтения списка поездок: /api/sessions (список),
  // /api/sessions/{id}/stats (статы записи; склейка Ф1 шлёт их пачкой по всем записям группы),
  // /api/geocode/reverse (адреса финиша). Вместе с ретраями react-query всплеск превышал
  // default 60/мин (429 «Повторите через 1 мин», статы карточек «—»). Тяжёлые чтения
  // (track/events) и мутации остаются в default-скопе.
  if (
    method === "GET" &&
    (pathname === "/api/sessions" || SESSION_STATS_RE.test(pathname) || pathname === "/api/geocode/reverse")
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
  if (scope === "plan" || scope === "audit" || scope === "admin:heavy" || scope === "admin:requeue") {
    const auth = request.headers.get("authorization") || "";
    const bearer = bearerToken(auth);
    if (bearer) {
      // Bearer-клиенты (админ-скрипты) — ключ по префиксу токена
      return rlKey(scope, bearer.slice(0, 16));
    }
    // v2.10.7: cookie-браузер без Authorization раньше давал общий бакет "no-token"
    // для ВСЕХ пользователей — лимит 1/час на admin:heavy исчерпывался чужими GET.
    // Теперь ключ по IP клиента (audited B-9: последняя запись XFF).
    return rlKey(scope, "ip", getClientIP(request));
  }
  return rlKey(scope, ip);
}

function bearerToken(auth: string): string | null {
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  const pathname = request.nextUrl.pathname;

  try {
    // 0. payload-size guard (до чтения body, §2.4)
    // Skip for ZIP imports (large files expected)
    const isZipImport = pathname === "/api/import/zip";
    // v2.11.0 (АУДИТ C-15): Number("") = 0, Number("abc") = NaN — старая проверка
    // `cl > maxBytes` пропускала NaN и «0» (chunked-encoding без content-length).
    // Теперь: нечисловой/отсутствующий header не считается «малым» — пропускаем
    // валидацию здесь (роуты-получатели с JSON-body имеют собственные лимиты чтения).
    const clRaw = request.headers.get("content-length");
    const cl = clRaw != null && clRaw.trim() !== "" && Number.isFinite(Number(clRaw)) ? Number(clRaw) : null;
    const maxBytes = isZipImport ? 100 * 1024 * 1024 : env().MAX_PAYLOAD_BYTES; // 100MB for ZIP, 256KB default
    if (cl != null && cl > maxBytes) {
      return json({ error: "Payload too large", limit: maxBytes }, 413, { "X-Request-Id": requestId });
    }

    // 1. CORS preflight
    if (request.method === "OPTIONS") {
      const r = corsResponse(request);
      r.headers.set("X-Request-Id", requestId);
      return r;
    }

    // 2. Rate limit (sliding window, in-memory в sandbox)
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

    // 3. Auth (кроме public) — P0-3: обязательна проверка ЗНАЧЕНИЙ токенов (timing-safe),
    // а не только формата: ранее любой Bearer ≥32 символов проходил гейт.
    const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
      // P1-9: GET share по токену — публичный (сам роут проверяет подпись и срок токена)
      || (SHARE_GET_RE.test(pathname) && request.method === "GET");
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
          // DIAG-1: неавторизованные попытки в БД не пишем (анти-абьюз) —
          // только in-memory счётчик в /api/metrics
          inc("ingest_unauthorized_total", "Ingest attempts rejected with 401 (bad or missing token)", 1, "ingest");
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
        // v2.11.0 (АУДИТ C-3): backup-кроны Render шлют CRON_SECRET — принимаем его
        // ТОЛЬКО для POST бэкапных путей (гейт; сам роут дополнительно проверяет
        // cron-токен). Раньше кроны получали 401 — автобэкапы не создавались ВООБЩЕ.
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
        // Default scope: финальная авторизация на уровне роута (authorizeRequest:
        // API_KEY, per-user apiKey, сессионная cookie) — БД недоступна в edge-middleware.
        if (!bearer && !hasCookie) {
          return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
        }
      }
    }

    // 4. Security headers + requestId
    // P2-16: прокидываем время старта в Node-роуты (edge → node канал).
    // Роуты вызывают trackLatency(request) и пополняют окно api_latency_p95 (§14.4).
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
