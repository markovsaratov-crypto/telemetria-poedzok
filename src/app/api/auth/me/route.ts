// GET /api/auth/me — проверка текущей сессии (multi-user aware)
import { NextRequest, NextResponse } from "next/server";
import {
  verifySessionCookieFromRequest,
  issueSessionCookie,
  issueUserCookie,
  setSessionCookie,
  // v2.38.1 (ревью F11): производный инжест-токен + маска apiKey
  deriveIngestToken,
  maskApiKeyPreview,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const session = await verifySessionCookieFromRequest(request);
  if (!session.ok) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }

  // Multi-user: sliding renewal re-issues user cookie
  if ("userId" in session.payload && session.user) {
    if (session.needsRenewal) {
      const renewed = await issueUserCookie(session.user);
      const response = NextResponse.json(
        {
          authenticated: true,
          sessionId: renewed.sessionId,
          expiresAt: renewed.expiresAt,
          renewed: true,
          user: renewed.user,
          // v2.38.1 (ревью F11): ingestToken — ПРОИЗВОДНЫЙ it_-токен
          // (HMAC-SHA256 от apiKey), а НЕ сам apiKey: ключ полного api-скопа
          // (сессии/статы/экспорт/share/delete) больше не покидает сервер и не
          // попадает в query-string SensorLogger Push URL. Ротация apiKey
          // автоматически ротирует этот токен.
          ingestToken: await deriveIngestToken(session.user.apiKey),
          // v2.38.1 (ревью F11): вместо полного apiKey — маска (первые 4…последние 4)
          apiKeyPreview: maskApiKeyPreview(session.user.apiKey),
        },
        { status: 200, headers: { "X-Request-Id": requestId } }
      );
      setSessionCookie(response, renewed.cookieValue);
      return response;
    }
    return NextResponse.json(
      {
        authenticated: true,
        expiresAt: new Date(session.payload.exp * 1000).toISOString(),
        user: { id: session.user.id, email: session.user.email, role: session.user.role },
        // v2.38.1 (ревью F11): производный it_-токен вместо сырого apiKey
        // (полный api-скоп не выдаётся наружу; см. ветку renewed выше)
        ingestToken: await deriveIngestToken(session.user.apiKey),
        apiKeyPreview: maskApiKeyPreview(session.user.apiKey),
      },
      { status: 200, headers: { "X-Request-Id": requestId } }
    );
  }

  // Legacy owner session
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
