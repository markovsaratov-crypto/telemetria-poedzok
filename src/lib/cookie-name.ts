// src/lib/cookie-name.ts — единый источник истины для имени сессионной cookie.
// __Host- префикс (только production): требует Secure, Path=/, без Domain (§6.1, P0-5).
// В dev (http://localhost) __Host- невозможен — используем базовое имя.
export const SESSION_COOKIE_BASE = "telem_session";

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? `__Host-${SESSION_COOKIE_BASE}`
    : SESSION_COOKIE_BASE;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
