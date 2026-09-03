// src/lib/share.ts — P1-9: stateless share-токены (HMAC от sessionId+срока, ключ SESSION_SECRET).
// Раньше токены жили в in-memory Map и терялись при рестарте процесса.
import { createHmac } from "crypto";
import { env } from "./env";
import { db } from "./db";
import { json } from "./http-utils";
import { haversineM } from "./geo";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint } from "./active-trip";
import { maxSpeedMs, normalizeSessionSpeeds } from "./kpi";
import { tokenMatches } from "./token-check"; // v2.16.0 (D-16): timing-safe сверка сигнатуры

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
  // v2.16.0 (D-16): timing-safe сверка через token-check (раньше — самодельный
  // XOR-цикл, дублирующий ту же логику)
  if (!tokenMatches(sig, expected)) return null;
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

  // FIX-C3: серверные KPI по методологии — раньше страница считала дистанцию
  // по всей записи (включая дрейф «хвостов») и среднюю скорость как
  // «вся дистанция / вся длительность», расходясь с админкой.
  const rawPoints = session.gpsPoints.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    speed: p.speed,
    altitude: p.altitude,
    bearing: p.bearing,
    accuracy: p.accuracy,
    timestamp: Number(p.timestamp),
  }));
  // B-4: нормализация скоростей — публичная страница согласована с админкой
  const points = normalizeSessionSpeeds(rawPoints);

  let rawDistanceM = 0;
  let distanceM = 0; // активная дистанция (§4.11)
  let activeDurationSec = 0;
  let preTripIdleSec = 0;
  let postTripIdleSec = 0;
  let hasActiveTrip = false;
  if (points.length >= 2) {
    const motion = computeMovingTime(points as MethodologyPoint[]);
    const active = computeActiveTrip(points as MethodologyPoint[], motion);
    hasActiveTrip = active.hasActiveTrip;
    activeDurationSec = active.activeDuration;
    preTripIdleSec = active.preTripIdle;
    postTripIdleSec = active.postTripIdle;
    for (let i = 1; i < points.length; i++) {
      const d = haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      rawDistanceM += d;
      if (hasActiveTrip && points[i].timestamp >= active.activeStartTime && points[i - 1].timestamp <= active.activeEndTime) {
        distanceM += d;
      }
    }
  }
  const maxSpeed = maxSpeedMs(points) ?? 0;

  return json(
    {
      sessionId: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      startTime: session.startTime,
      endTime: session.endTime,
      pointCount: session.pointCount,
      points: points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed,
        altitude: p.altitude,
        timestamp: p.timestamp,
      })),
      // FIX-C3: серверные KPI (активная часть) — клиент только отображает
      distanceM: Math.round(distanceM),
      rawDistanceM: Math.round(rawDistanceM),
      activeDurationSec: Math.round(activeDurationSec),
      preTripIdleSec: Math.round(preTripIdleSec),
      postTripIdleSec: Math.round(postTripIdleSec),
      hasActiveTrip,
      maxSpeedMs: Math.round(maxSpeed * 10) / 10,
      shared: true,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    200,
    { "X-Request-Id": requestId }
  );
}

