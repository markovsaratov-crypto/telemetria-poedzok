// src/lib/contracts.ts — формальные контракты модулей для DI/тестирования (§2.5)
import type { NextRequest } from "next/server";

export interface IIdempotencyService {
  findExisting(deviceId: string, clientId: string): Promise<string | null>;
}

export interface IRateLimiter {
  check(
    key: string,
    limit: number,
    windowSec: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfter: number; limit: number; reset: number }>;
}

export interface IAuthProvider {
  verifyPassword(input: string): Promise<boolean>;
  issueCookie(): Promise<{ sessionId: string; expiresAt: string }>;
  verifyCookie(): Promise<{ ok: true; payload: { sub: string; iat: number; exp: number }; needsRenewal: boolean } | { ok: false }>;
}

export interface IRouteProvider {
  name: string;
  route(startLat: number, startLon: number, endLat: number, endLon: number): Promise<unknown>;
}

export interface IAuditLogger {
  write(input: {
    action: string;
    targetId: string;
    targetType: string;
    actorType: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<void>;
}
