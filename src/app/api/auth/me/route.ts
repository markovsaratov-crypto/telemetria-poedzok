// GET /api/auth/me — проверка текущей сессии
import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookieFromRequest, issueSessionCookie, setSessionCookie, COOKIE_NAME } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const session = await verifySessionCookieFromRequest(request);
  if (!session.ok) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }
  // Sliding renewal
  if (session.needsRenewal) {
    const renewed = await issueSessionCookie();
    const response = NextResponse.json(
      { authenticated: true, sessionId: renewed.sessionId, expiresAt: renewed.expiresAt, renewed: true },
      { status: 200, headers: { "X-Request-Id": requestId } }
    );
    setSessionCookie(response, renewed.cookieValue);
    return response;
  }
  return NextResponse.json(
    { authenticated: true, expiresAt: new Date(session.payload.exp * 1000).toISOString() },
    { status: 200, headers: { "X-Request-Id": requestId } }
  );
}
