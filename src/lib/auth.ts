// src/lib/auth.ts — multi-user авторизация ON TOP of existing single-user.
// Блокер №3 FIX: /api/auth/login — LOGIN_PASSWORD timing-safe, stateless HMAC cookie.
// Multi-user (RESTORE-ALL): bcrypt-hashed per-user accounts + per-user apiKey.
import { NextRequest, NextResponse } from "next/server";
import { env } from "./env";
import { getClientIP } from "./http-utils";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";
import { userDb, type UserRow } from "./user-db";
// v2.38.1 (ревью F11): edge-safe хелперы для производного инжест-токена it_
import { INGEST_TOKEN_RE, deriveIngestToken as deriveIngestTokenHex, tokenMatches } from "./token-check";
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

// === v2.38.1 (ревью F11): производный инжест-токен (ingest-only) ===
// it_<32 hex> = первые 32 символа hex(HMAC-SHA256(SESSION_SECRET, "<apiKey>:ingest")).
// Зачем: раньше SensorLogger Push URL получал из /api/auth/me САМ apiKey (полный
// api-скоп: сессии/статы/экспорт/share/delete) и таскал его в query-string —
// query оседает в access-логах CDN/Render, истории браузера. it_-токен даёт
// ТОЛЬКО инжест. Ротация apiKey автоматически ротирует it_-токен (HMAC от
// apiKey); ротация SESSION_SECRET инвалидирует все it_-токены — пользователи
// копируют новые из /api/auth/me (docs/SECURITY-ROTATION.md).

// Вычислить it_-токен пользователя по его apiKey.
export async function deriveIngestToken(apiKey: string): Promise<string> {
  return deriveIngestTokenHex(apiKey, env().SESSION_SECRET);
}

// Проверить it_-токен → пользователь или null. Таблица User маленькая
// (single-owner продукт) — перебираем apiKey и сверяем производные токены
// timing-safe (tokenMatches). Токен чужого формата → сразу null без SQL.
// Обратного словаря нет намеренно: токен не хранится в БД (stateless HMAC),
// схема не требует миграций prisma-схемы.
export async function verifyIngestToken(token: string | null | undefined): Promise<UserRow | null> {
  if (!token || !INGEST_TOKEN_RE.test(token)) return null;
  const users = await userDb.findAll();
  for (const u of users) {
    const expected = await deriveIngestToken(u.apiKey);
    if (await tokenMatches(token, expected)) return u;
  }
  return null;
}

// Маска apiKey для показа пользователю (полное значение больше не покидает
// сервер): первые 4 + … + последние 4 символа.
export function maskApiKeyPreview(apiKey: string): string {
  return apiKey.length > 12 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…";
}

// ЕДИНАЯ проверка инжест-авторизации для гейта прокси и обоих инжест-роутов
// (до этого логика была размазана по трём местам — классический «починил в
// одном, сломал в другом»). Возвращает userId личного канала (null =
// глобальный канал владельца) или причину отказа. Правила:
//   1) глобальный INGEST_TOKEN — Bearer ИЛИ ?token= (SensorLogger не умеет
//      заголовки; канал владельца, userId IS NULL);
//   2) производный it_-токен — Bearer (предпочтительно) ИЛИ ?token=
//      (совместимость SensorLogger Push URL: значение бесполезно без
//      SESSION_SECRET и не даёт api-скопа — утечка логов некритична);
//   3) сырой per-user apiKey — ТОЛЬКО Authorization: Bearer (заголовок не
//      пишется в access-логи). Из ?token= apiKey больше НЕ принимается:
//      query-string оседает в логах CDN/Render (ревью F11).
export type IngestAuth =
  | { ok: true; userId: string | null }
  | { ok: false; reason: string };

export async function resolveIngestToken(
  bearer: string | null,
  queryToken: string | null
): Promise<IngestAuth> {
  const e = env();
  if (bearer && (await tokenMatches(bearer, e.INGEST_TOKEN))) return { ok: true, userId: null };
  if (queryToken && (await tokenMatches(queryToken, e.INGEST_TOKEN))) return { ok: true, userId: null };
  const presented = bearer ?? queryToken;
  if (presented && INGEST_TOKEN_RE.test(presented)) {
    const u = await verifyIngestToken(presented);
    if (u) return { ok: true, userId: u.id };
    return { ok: false, reason: "Invalid it_ ingest token" };
  }
  if (bearer) {
    const u = await userDb.findByApiKey(bearer);
    if (u) return { ok: true, userId: u.id };
    if (queryToken) {
      return {
        ok: false,
        reason:
          "Per-user apiKey is accepted only via Authorization: Bearer; use the it_ ingest token in ?token= (copy from /api/auth/me)",
      };
    }
    return { ok: false, reason: "Invalid ingest token (Bearer INGEST_TOKEN, it_ token or Bearer apiKey required)" };
  }
  return { ok: false, reason: "Valid INGEST_TOKEN or it_ ingest token required (Bearer header or ?token= query)" };
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
    // v2.38.1 (ревью F11): производный it_-токен — ТОЛЬКО ingest-скоп.
    // Ветка требует scope="ingest" (для scope="api" it_-токен не матчится
    // ни с API_KEY, ни с чьим-либо apiKey → корректный отказ ниже) —
    // ingest-only по построению, даже при утечке логов CDN.
    if (scope === "ingest" && INGEST_TOKEN_RE.test(bearer)) {
      const u = await verifyIngestToken(bearer);
      if (u) {
        return { ok: true, via: "bearer", userId: u.id, role: "ingest" };
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
