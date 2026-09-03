// GET /api/sessions/[id]/events — детекция harsh events для G-G диаграммы.
// Возвращает longitudinal/lateral acceleration для каждой точки + harsh events список.
// v2.10.0: real AccelerationRMS/JerkRMS вместо seeded-манёвров.
// v2.12.0 (D-6): скорости нормализуются (AUDIT B-4) и сглаживаются 3-точечной
// медией — GPS-джиттер больше не порождает фантомные «резкие» события.
// v2.19.0: вычисление — в src/lib/session-events.ts (ЕДИНЫЙ конвейер с
// батч-роутом /api/events/batch); роут — тонкая обёртка auth→db→конвейер.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { computeSessionEvents } from "@/lib/session-events";

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
      include: { gpsPoints: { orderBy: { timestamp: "asc" }, select: { lat: true, lon: true, timestamp: true, speed: true, bearing: true, accuracy: true } } },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // v2.18.0: типизированный db — gpsPoints unknown
    const gpsPts = (session.gpsPoints ?? []) as Array<Record<string, unknown>>;
    const rawPoints = gpsPts.map((p) => ({
      lat: Number(p.lat),
      lon: Number(p.lon),
      timestamp: Number(p.timestamp),
      speed: p.speed == null ? null : Number(p.speed),
      bearing: p.bearing == null ? null : Number(p.bearing),
      accuracy: p.accuracy == null ? null : Number(p.accuracy),
      altitude: null, // исторически так в events-роуте; конвейер не читает
    }));

    const payload = computeSessionEvents(id, String(session.deviceId), rawPoints);
    return json(payload, 200, { "X-Request-Id": requestId });
  } catch (e) {
    // v2.16.0 (B2): наружу — только generic-текст (детали SQL/внутренностей —
    // в логи; было два роута из всех, что сыпали err.message клиенту)
    logger.error("events fetch failed", { requestId, error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
