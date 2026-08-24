// POST /api/auth/logout — очистка cookie
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
