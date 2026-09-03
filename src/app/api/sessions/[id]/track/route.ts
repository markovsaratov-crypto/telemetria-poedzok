// GET /api/sessions/[id]/track — компактный polyline для Leaflet MapTrack.
// Возвращает массив точек {lat,lng,t,v,st,alt} + segments по скорости (5 цветов) + harsh points.
// v2.10.0: карта по умолчанию открывается в слое street (OSM Standard tiles).
// v2.19.0: вычисление — в src/lib/session-track.ts (ЕДИНЫЙ конвейер с
// батч-роутом /api/track/batch); роут — тонкая обёртка auth→db→конвейер.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { computeSessionTrack } from "@/lib/session-track";

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
      include: { gpsPoints: { orderBy: { timestamp: "asc" }, select: { lat: true, lon: true, timestamp: true, speed: true, altitude: true, accuracy: true, bearing: true } } },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // v2.18.0: типизированный db — gpsPoints unknown, локальная типизация
    type TrackPoint = { lat: number; lon: number; speed: number | null; timestamp: number; bearing: number | null; accuracy: number | null; altitude: number | null };
    const points = (session.gpsPoints ?? []) as unknown as TrackPoint[];
    const rawPoints = points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      timestamp: Number(p.timestamp),
      speed: p.speed,
      bearing: p.bearing,
      accuracy: p.accuracy,
      altitude: p.altitude,
    }));

    const payload = computeSessionTrack(
      {
        id,
        deviceId: String(session.deviceId),
        startTime: String(session.startTime),
        endTime: session.endTime == null ? null : String(session.endTime),
        pointCount: session.pointCount == null ? null : Number(session.pointCount),
      },
      rawPoints
    );
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (e) {
    // v2.16.0 (B1): наружу — только generic-текст (детали — в логи)
    logger.error("track fetch failed", { requestId, error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
