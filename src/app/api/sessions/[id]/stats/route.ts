// GET /api/sessions/[id]/stats — детальная статистика по сессии.
// Возвращает: distance, duration, avgSpeed, maxSpeed, avgAltitude, elevationGain/loss, movingTime, idleTime.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { haversine } from "@/lib/routing/chain";

const EARTH_R = 6371000;

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

export async function GET(
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
      select: {
        id: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        deletedAt: true,
        gpsPoints: {
          orderBy: { timestamp: "asc" },
          select: { lat: true, lon: true, speed: true, altitude: true, timestamp: true },
        },
      },
    });

    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const points = session.gpsPoints.map((p) => ({
      ...p,
      timestamp: Number(p.timestamp),
    }));

    if (points.length === 0) {
      return json(
        { sessionId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // Расчёт дистанции
    let distance = 0;
    let maxSpeed = 0;
    let speedSum = 0;
    let speedCount = 0;
    let elevationGain = 0;
    let elevationLoss = 0;
    let prevAlt: number | null = null;
    let movingTime = 0;
    let idleTime = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      // Distance
      if (i > 0) {
        const prev = points[i - 1];
        distance += haversineM(prev.lat, prev.lon, p.lat, p.lon);

        // Moving vs idle (speed > 1 m/s = moving)
        const dt = (p.timestamp - prev.timestamp) / 1000;
        if (dt > 0 && dt < 300) {
          const isMoving = (p.speed ?? 0) > 1;
          if (isMoving) movingTime += dt;
          else idleTime += dt;
        }
      }

      // Speed stats
      if (p.speed != null && p.speed >= 0) {
        maxSpeed = Math.max(maxSpeed, p.speed);
        speedSum += p.speed;
        speedCount++;
      }

      // Elevation
      if (p.altitude != null) {
        if (prevAlt != null) {
          const diff = p.altitude - prevAlt;
          if (diff > 0) elevationGain += diff;
          else elevationLoss += Math.abs(diff);
        }
        prevAlt = p.altitude;
      }
    }

    const startTime = new Date(session.startTime).getTime();
    const endTime = session.endTime
      ? new Date(session.endTime).getTime()
      : points.length > 0
      ? points[points.length - 1].timestamp
      : startTime;
    const durationSec = Math.max(0, (endTime - startTime) / 1000);
    const avgSpeed = speedCount > 0 ? speedSum / speedCount : null;

    // Bounding box
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const bbox = {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };

    return json(
      {
        sessionId: id,
        pointCount: points.length,
        distance: Math.round(distance),
        duration: Math.round(durationSec),
        movingTime: Math.round(movingTime),
        idleTime: Math.round(idleTime),
        avgSpeed: avgSpeed != null ? Math.round(avgSpeed * 10) / 10 : null,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        avgAltitude: prevAlt != null ? Math.round(points.filter((p) => p.altitude != null).reduce((a, p) => a + (p.altitude || 0), 0) / (points.filter((p) => p.altitude != null).length || 1)) : null,
        elevationGain: Math.round(elevationGain),
        elevationLoss: Math.round(elevationLoss),
        bbox,
        startTime: session.startTime,
        endTime: session.endTime,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Session stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
