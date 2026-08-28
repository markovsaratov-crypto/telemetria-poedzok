// POST /api/auth/register — multi-user registration.
// First registered user becomes admin (bootstrapping); subsequent users get role="user".
import { NextRequest, NextResponse } from "next/server";
import { zRegisterBody } from "@/lib/validation";
import { hashPassword, issueUserCookie, setSessionCookie } from "@/lib/auth";
import { userDb } from "@/lib/user-db";
import { createRateLimiter, rlKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { getClientIP } from "@/lib/http-utils";
import { inc } from "@/lib/metrics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const body = await request.json().catch(() => null);
    const parsed = zRegisterBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const ip = getClientIP(request);
    const limiter = createRateLimiter();
    const rl = await limiter.check(rlKey("auth:register", ip), Math.max(env().RATE_LIMIT_MAX_AUTH, 3), 60);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many registration attempts", retryAfter: rl.retryAfter },
        { status: 429, headers: { "X-Request-Id": requestId, "Retry-After": String(rl.retryAfter) } }
      );
    }

    const { email, password } = parsed.data;

    // Check email uniqueness
    const existing = await userDb.findByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409, headers: { "X-Request-Id": requestId } }
      );
    }

    // First user becomes admin
    const userCount = await userDb.count();
    const role = userCount === 0 ? "admin" : "user";

    const passwordHash = await hashPassword(password);
    const user = await userDb.create({ email, passwordHash, role });

    const { sessionId, expiresAt, cookieValue, user: userPublic } = await issueUserCookie(user);
    const response = NextResponse.json(
      { sessionId, expiresAt, authenticated: true, user: userPublic },
      { status: 201, headers: { "X-Request-Id": requestId } }
    );
    setSessionCookie(response, cookieValue);
    inc("auth_register_total", "Auth registrations", 1);
    logger.info("Register success", { requestId, ip, userId: user.id, role });
    return response;
  } catch (err) {
    logger.error("Register error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
