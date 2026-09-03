// POST /api/auth/login — multi-user (email+password) OR legacy single-user (LOGIN_PASSWORD).
// Блокер №3 FIX: HMAC cookie, timing-safe password compare.
import { NextRequest, NextResponse } from "next/server";
import { zLoginBody } from "@/lib/validation";
import {
  verifyPassword,
  verifyPasswordHash,
  issueSessionCookie,
  issueUserCookie,
  setSessionCookie,
} from "@/lib/auth";
import { userDb } from "@/lib/user-db";
import { inc } from "@/lib/metrics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

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

    // v2.11.0 (АУДИТ C-19): rate-limit логина УБРАН из роута — прокси уже
    // проверяет тот же бакет auth:login (тот же ключ rl:auth:login:<ip>) —
    // двойное списание съедало лимит: 5 попыток/мин превращались в ~2.5.
    // Брутфорс-защита не ослабла: прокси отвечает 429 до роута.

    const { email, password } = parsed.data;

    // Multi-user path: email present
    if (email) {
      const user = await userDb.findByEmail(email);
      // Always run bcrypt to keep timing consistent (mitigate user-enumeration).
      const dummyHash = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8eVjP3wW5PbP8bVqQkPbVbNfQ2JyQC";
      const ok = await verifyPasswordHash(password, user?.passwordHash ?? dummyHash);
      if (!user || !ok) {
        inc("auth_login_failed_total", "Auth login failures", 1);
        logger.warn("Login failed (multi-user bad creds)", { requestId, email });
        return NextResponse.json(
          { error: "Неверный email или пароль" },
          { status: 401, headers: { "X-Request-Id": requestId } }
        );
      }
      const { sessionId, expiresAt, cookieValue, user: userPublic } = await issueUserCookie(user);
      const response = NextResponse.json(
        { sessionId, expiresAt, authenticated: true, user: userPublic },
        { status: 200, headers: { "X-Request-Id": requestId } }
      );
      setSessionCookie(response, cookieValue);
      inc("auth_login_success_total", "Auth login successes", 1);
      logger.info("Login success (multi-user)", { requestId, userId: user.id });
      return response;
    }

    // Legacy single-user path (no email provided): fallback to LOGIN_PASSWORD
    const ok = await verifyPassword(password);
    if (!ok) {
      inc("auth_login_failed_total", "Auth login failures", 1);
      logger.warn("Login failed (bad password)", { requestId });
      return NextResponse.json(
        { error: "Неверный email или пароль" },
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
    logger.info("Login success (legacy owner)", { requestId, sessionId });
    return response;
  } catch (err) {
    logger.error("Login error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
