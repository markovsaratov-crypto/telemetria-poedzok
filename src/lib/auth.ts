// src/lib/auth.ts — multi-user авторизация ON TOP of existing single-user.
// Блокер №3 FIX: /api/auth/login — LOGIN_PASSWORD timing-safe, stateless HMAC cookie.
// Multi-user (RESTORE-ALL): bcrypt-hashed per-user accounts + per-user apiKey.
import { NextRequest, NextResponse } from "next/server";
import { env } from "./env";
import { getClientIP } from "./http-utils";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";
import { userDb, type UserRow } from "./user-db";
import bcrypt from "bcryptjs";
import { sessionCookieName, isProduction } from "./cookie-name";

const COOKIE_NAME = sessionCookieName();
const COOKIE_TTL_SEC = 86400; // 24 часа
const RENEW_THRESHOLD_SEC = 3600; // обновляем если до exp < 1 часа

// Multi-user cookie payload: either legacy owner OR per-user.
interface OwnerPayload {
  sub: "owner";
  iat: number;
  exp: number;
}
interface UserPayload {
  userId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}
type CookiePayload = OwnerPayload | UserPayload;

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

// === Multi-user: bcrypt password helpers ===
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPasswordHash(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Установка cookie в response (вместо next/headers cookies())
// P0-5 / §6.1: Secure, SameSite=Strict, __Host- префикс в продакшене.
export function setSessionCookie(response: NextResponse, cookieValue: string): void {
  response.cookies.set(COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_TTL_SEC,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

// === Legacy single-user cookie issue ===
export async function issueSessionCookie(): Promise<{
  sessionId: string;
  expiresAt: string;
  cookieValue: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const payload: OwnerPayload = {
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

// === Multi-user cookie issue ===
export async function issueUserCookie(user: UserRow): Promise<{
  sessionId: string;
  expiresAt: string;
  cookieValue: string;
  user: { id: string; email: string; role: string };
}> {
  const now = Math.floor(Date.now() / 1000);
  const payload: UserPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
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
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function verifySessionCookieFromRequest(
  request: NextRequest
): Promise<
  | { ok: true; payload: CookiePayload; needsRenewal: boolean; user?: UserRow | null }
  | { ok: false }
> {
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

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false };

  const needsRenewal = payload.exp - now < RENEW_THRESHOLD_SEC;

  // For user payload: fetch latest user (so revoked/changed role is reflected)
  if ("userId" in payload) {
    const user = await userDb.findById(payload.userId);
    if (!user) return { ok: false };
    return { ok: true, payload, needsRenewal, user };
  }

  // Legacy owner payload
  if (payload.sub !== "owner") return { ok: false };
  return { ok: true, payload, needsRenewal };
}

// Timing-safe сравнение пароля (§6.1, защита от timing-атак)
// Single-user legacy fallback (LOGIN_PASSWORD env).
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

// === Multi-user helpers ===

// Extract userId from request: works for both user cookie and legacy owner cookie.
export async function getUserIdFromRequest(
  request: NextRequest
): Promise<string | null> {
  const session = await verifySessionCookieFromRequest(request);
  if (!session.ok) return null;
  if ("userId" in session.payload) return session.payload.userId;
  return null; // legacy owner — no userId
}

// v2.16.0: getUserRoleFromRequest удалён — 0 потребителей (роли даёт authorizeRequest).

// Require any authenticated user (cookie or bearer). Throws HTTP response on failure.
export type AuthResult =
  | { ok: true; via: "cookie" | "bearer"; userId: string | null; role: string }
  | { ok: false; reason: string };

// Комбинированная авторизация: cookie ИЛИ bearer.
// Bearer API_KEY (legacy) AND per-user apiKey both accepted for scope=api.
export async function authorizeRequest(
  request: NextRequest,
  scope: BearerScope = "api"
): Promise<AuthResult> {
  // 1. Bearer: legacy API_KEY/ADMIN_TOKEN OR per-user apiKey
  const bearer = extractBearer(request);
  if (bearer) {
    // Legacy env-based bearer (any scope)
    if (authenticateBearer(bearer, scope)) {
      return { ok: true, via: "bearer", userId: null, role: scope === "admin" ? "admin" : "api" };
    }
    // Per-user apiKey (scope=api only)
    if (scope === "api") {
      const u = await userDb.findByApiKey(bearer);
      if (u) {
        return { ok: true, via: "bearer", userId: u.id, role: u.role };
      }
    }
  }
  // 2. Cookie (только для scope=api/admin — веб-клиент)
  if (scope === "api" || scope === "admin") {
    const session = await verifySessionCookieFromRequest(request);
    if (session.ok) {
      // v2.18.0 (P1): роль — из СВЕЖЕЙ строки User, а не из подписи cookie.
      // verifySessionCookieFromRequest уже гоняет запрос в БД («revoked/changed
      // role is reflected»), но authorizeRequest читал payload.role — роль на
      // момент ВЫДАЧИ cookie (до 24 ч назад): разжалованный admin сохранял
      // доступ ко всем /api/admin/* до истечения cookie. Удаление пользователя
      // продолжало работать (там user == null → 401) — отставала только роль.
      let role: string;
      let userId: string | null;
      if ("userId" in session.payload) {
        role = session.user?.role ?? session.payload.role;
        userId = session.payload.userId;
      } else {
        role = "owner";
        userId = null;
      }
      // For admin scope: owner role OR user role==="admin" allowed.
      if (scope === "admin" && role !== "owner" && role !== "admin") {
        return { ok: false, reason: "Forbidden: admin role required" };
      }
      return { ok: true, via: "cookie", userId, role };
    }
  }
  return { ok: false, reason: "Unauthorized" };
}

// v2.16.0: requireUser/requireAdmin удалены — 0 потребителей (все роуты зовут
// authorizeRequest напрямую).

// v2.18.0: ЕДИНЫЙ authorizeAdminOrCron (v2.11.0 АУДИТ C-3) — до этого 8-строчный
// хелпер копировался дословно в /api/admin/backup и /api/admin/backup/github
// (классический «починил в одном — сломал в другом»). Пропускает админа ИЛИ
// backup-крон с CRON_SECRET (гейт proxy пускает CRON_SECRET только на POST).
export async function authorizeAdminOrCron(request: NextRequest): Promise<AuthResult> {
  let auth = await authorizeRequest(request, "admin");
  if (!auth.ok) {
    const cron = await authorizeRequest(request, "cron");
    if (cron.ok) auth = { ok: true, via: "bearer", userId: null, role: "cron" };
  }
  return auth;
}

export { COOKIE_NAME, COOKIE_TTL_SEC, getClientIP };
