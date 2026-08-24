// POST /api/auth/login — single-user, LOGIN_PASSWORD timing-safe, HMAC cookie (блокер №3)
import { NextRequest, NextResponse } from "next/server";
import { zLoginBody } from "@/lib/validation";
import { verifyPassword, issueSessionCookie, setSessionCookie, COOKIE_NAME } from "@/lib/auth";
import { createRateLimiter, rlKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { getClientIP } from "@/lib/http-utils";
import { inc } from "@/lib/metrics";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const body = await request.json().catch(() => null);
    const parsed = zLoginBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Отдельный rate limit на логин (защита от брутфорса, §6.9)
    const ip = getClientIP(request);
    const limiter = createRateLimiter();
    const rl = await limiter.check(rlKey("auth:login", ip), env().RATE_LIMIT_MAX_AUTH, 60);
    if (!rl.allowed) {
      inc("auth_login_rate_limited_total", "Auth login rate limited", 1);
      return NextResponse.json(
        { error: "Too many login attempts", retryAfter: rl.retryAfter },
        {
          status: 429,
          headers: {
            "X-Request-Id": requestId,
            "Retry-After": String(rl.retryAfter),
          },
        }
      );
    }

    const ok = await verifyPassword(parsed.data.password);
    if (!ok) {
      inc("auth_login_failed_total", "Auth login failures", 1);
      logger.warn("Login failed (bad password)", { requestId, ip });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      );
    }

    const { sessionId, expiresAt, cookieValue } = await issueSessionCookie();
    const response = NextResponse.json(
      { sessionId, expiresAt, authenticated: true },
      { status: 200, headers: { "X-Request-Id": requestId } }
    );
    setSessionCookie(response, cookieValue);
    inc("auth_login_success_total", "Auth login successes", 1);
    logger.info("Login success", { requestId, ip, sessionId });
    return response;
  } catch (err) {
    logger.error("Login error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
