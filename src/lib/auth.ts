// src/lib/auth.ts — single-user авторизация (§6.1).
// Блокер №3 FIX: /api/auth/login — LOGIN_PASSWORD timing-safe, stateless HMAC cookie.
import { NextRequest, NextResponse } from "next/server";
import { env } from "./env";
import { getClientIP } from "./http-utils";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";

const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-telem_session" : "telem_session";
const COOKIE_TTL_SEC = 86400; // 24 часа
const RENEW_THRESHOLD_SEC = 3600; // обновляем если до exp < 1 часа

interface CookiePayload {
  sub: "owner";
  iat: number; // sec
  exp: number; // sec
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

async function hmacSign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env().SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}

async function hmacVerify(data: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(data);
  return safeEqual(sig, expected);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return nodeTimingSafeEqual(bufA, bufB);
}

// Установка cookie в response (вместо next/headers cookies())
export function setSessionCookie(response: NextResponse, cookieValue: string): void {
  response.cookies.set(COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_TTL_SEC,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function issueSessionCookie(): Promise<{
  sessionId: string;
  expiresAt: string;
  cookieValue: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const payload: CookiePayload = {
    sub: "owner",
    iat: now,
    exp: now + COOKIE_TTL_SEC,
  };
  const payloadStr = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSign(payloadStr);
  const cookieValue = `${payloadStr}.${sig}`;
  const sessionId = `sess_${payloadStr.slice(0, 16)}`;
  return {
    sessionId,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    cookieValue,
  };
}

export async function verifySessionCookieFromRequest(
  request: NextRequest
): Promise<{ ok: true; payload: CookiePayload; needsRenewal: boolean } | { ok: false }> {
  const raw = request.cookies.get(COOKIE_NAME)?.value;
  if (!raw) return { ok: false };

  const [payloadStr, sig] = raw.split(".");
  if (!payloadStr || !sig) return { ok: false };

  const valid = await hmacVerify(payloadStr, sig);
  if (!valid) return { ok: false };

  let payload: CookiePayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadStr));
  } catch {
    return { ok: false };
  }
  if (payload.sub !== "owner") return { ok: false };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false };

  const needsRenewal = payload.exp - now < RENEW_THRESHOLD_SEC;
  return { ok: true, payload, needsRenewal };
}

// Timing-safe сравнение пароля (§6.1, защита от timing-атак)
export async function verifyPassword(input: string): Promise<boolean> {
  const expected = env().LOGIN_PASSWORD;
  return safeEqual(input, expected);
}

// Bearer-токены (§6.1, таблица 8)
export type BearerScope = "api" | "ingest" | "cron" | "admin";

export function extractBearer(request: NextRequest): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function authenticateBearer(token: string | null, scope: BearerScope): boolean {
  if (!token) return false;
  const e = env();
  const expected =
    scope === "api" ? e.API_KEY : scope === "ingest" ? e.INGEST_TOKEN : scope === "cron" ? e.CRON_SECRET : e.ADMIN_TOKEN;
  return safeEqual(token, expected);
}

// Комбинированная авторизация: cookie ИЛИ bearer
export async function authorizeRequest(
  request: NextRequest,
  scope: BearerScope = "api"
): Promise<{ ok: true; via: "cookie" | "bearer" } | { ok: false; reason: string }> {
  // 1. Bearer
  const bearer = extractBearer(request);
  if (bearer && authenticateBearer(bearer, scope)) {
    return { ok: true, via: "bearer" };
  }
  // 2. Cookie (только для scope=api/admin — веб-клиент)
  if (scope === "api" || scope === "admin") {
    const session = await verifySessionCookieFromRequest(request);
    if (session.ok) return { ok: true, via: "cookie" };
  }
  return { ok: false, reason: "Unauthorized" };
}

export { COOKIE_NAME, COOKIE_TTL_SEC, getClientIP };
