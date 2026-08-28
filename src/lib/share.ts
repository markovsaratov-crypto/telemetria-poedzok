// src/lib/share.ts — P1-9: stateless share-токены (HMAC от sessionId+срока, ключ SESSION_SECRET).
// Раньше токены жили в in-memory Map и терялись при рестарте процесса.
import { createHmac } from "crypto";
import { env } from "./env";
import { db } from "./db";
import { json } from "./http-utils";

export const SHARE_DEFAULT_TTL_HOURS = 168; // 7 дней
export const SHARE_MAX_TTL_HOURS = 8760; // 1 год

export function makeShareToken(sessionId: string, ttlHours: number): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlHours * 3600 * 1000;
  const exp36 = expiresAt.toString(36);
  return { token: `${sessionId}.${exp36}.${sign(sessionId, exp36)}`, expiresAt };
}

function sign(sessionId: string, exp36: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(`${sessionId}:${exp36}`).digest("hex").slice(0, 32);
}

export function verifyShareToken(token: string): { sessionId: string; expiresAt: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, exp36, sig] = parts;
  if (!sessionId || !exp36 || !sig) return null;
  if (!/^[0-9a-f]{32}$/.test(sig)) return null;
  const expected = sign(sessionId, exp36);
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const expiresAt = parseInt(exp36, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { sessionId, expiresAt };
}

// Общий payload для обоих share-GET-роутов (sessions/[id]/share и /api/share)
export async function sharePayload(sessionId: string, expiresAt: number, requestId: string) {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: {
      gpsPoints: { orderBy: { timestamp: "asc" } },
    },
  });

  if (!session || session.deletedAt) {
    return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
  }

  return json(
    {
      sessionId: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      startTime: session.startTime,
      endTime: session.endTime,
      pointCount: session.pointCount,
      points: session.gpsPoints.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed,
        altitude: p.altitude,
        timestamp: Number(p.timestamp),
      })),
      shared: true,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    200,
    { "X-Request-Id": requestId }
  );
}

