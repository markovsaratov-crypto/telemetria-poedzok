// POST /api/auth/logout — очистка cookie
// v2.38.2 (ревью F29, note): этот роут чистит cookie ТОЛЬКО в браузере, откуда
// пришёл запрос. Сессия stateless (HMAC-cookie, БД-стороны нет) — украденная
// КОПИЯ cookie после «логина-аута» жертвы остаётся валидной до exp (24 ч,
// продлевается sliding-renewal). Полный отзыв невозможен без серверного сторa
// (denylist) — основной риск закрыт отпечатком пароля pwdFp (src/lib/auth.ts):
// смена пароля жертвы мгновенно убивает и украденную cookie. Ограничение
// задокументировано в ревью F29 как осознанное.
import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";
import { inc } from "@/lib/metrics";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const response = NextResponse.json(
    { ok: true },
    { status: 200, headers: { "X-Request-Id": requestId } }
  );
  clearSessionCookie(response);
  inc("auth_logout_total", "Auth logouts", 1);
  return response;
}

export async function GET(request: NextRequest) {
  return POST(request);
}
