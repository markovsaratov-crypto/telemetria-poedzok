// POST /api/sessions/[id]/share — создать shareable token для сессии.
// GET /api/sessions/[id]/share?token=xxx — получить сессию по share token.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createHash } from "crypto";

// In-memory store для share tokens (в прод-системе было бы в БД)
const shareStore = new Map<string, { sessionId: string; createdAt: number; expiresAt: number }>();

function generateToken(sessionId: string): string {
  const secret = env().SESSION_SECRET;
  const ts = Date.now();
  const hash = createHash("sha256").update(`${sessionId}:${ts}:${secret}`).digest("hex");
  return hash.slice(0, 32);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const session = await db.session.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, deviceId: true },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // Проверяем, есть ли уже активный token
    let existing: string | null = null;
    for (const [token, data] of shareStore.entries()) {
      if (data.sessionId === id && data.expiresAt > Date.now()) {
        existing = token;
        break;
      }
    }

    let token: string;
    let expiresAt: number;
    if (existing) {
      token = existing;
      expiresAt = shareStore.get(token)!.expiresAt;
    } else {
      token = generateToken(id);
      const now = Date.now();
      expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 дней
      shareStore.set(token, { sessionId: id, createdAt: now, expiresAt });
    }

    await writeAudit({
      action: "session.share",
      targetId: id,
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: id,
      metadata: { token: token.slice(0, 8) + "…", expiresAt: new Date(expiresAt).toISOString() },
    });

    return json(
      {
        token,
        url: `/shared/${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
        sessionId: id,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Share create error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return json({ error: "token required" }, 400, { "X-Request-Id": requestId });
    }

    const shareData = shareStore.get(token);
    if (!shareData || shareData.sessionId !== id || shareData.expiresAt < Date.now()) {
      return json({ error: "Invalid or expired token" }, 403, { "X-Request-Id": requestId });
    }

    // Возвращаем сессию с точками (без auth — публичный доступ)
    const session = await db.session.findUnique({
      where: { id },
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
        expiresAt: new Date(shareData.expiresAt).toISOString(),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Share get error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
