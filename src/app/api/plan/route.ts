// POST /api/plan — построение маршрута с кэшем (§4.4)
// GET /api/plan/[sessionId] — план для сессии (§4.5)
import { NextRequest } from "next/server";
import { zPlanBody } from "@/lib/validation";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { routeRequest } from "@/lib/routing/chain";
import { cacheGet, cacheSet, cacheHash, todBucket } from "@/lib/cache";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zPlanBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const { startLat, startLon, endLat, endLon, sessionId } = parsed.data;

    // Кэш: snap-to-grid + ToD bucket
    const bucket = todBucket();
    const hash = cacheHash(startLat, startLon, endLat, endLon, bucket);
    const cached = await cacheGet(hash);
    if (cached) {
      inc("plan_cache_hit_total", "Plan cache hits", 1);
      const result = JSON.parse(cached);
      return json({ ...result, cached: true }, 200, { "X-Request-Id": requestId });
    }

    inc("plan_cache_miss_total", "Plan cache misses", 1);
    const route = await routeRequest(startLat, startLon, endLat, endLon);
    inc("routing_provider_total", "Routing provider usage", 1, route.provider);
    if (route.provider !== "2gis") {
      inc("routing_fallback_total", "Routing provider fallbacks", 1, route.provider);
    }

    // Сохраняем в кэш
    const routeJson = JSON.stringify(route);
    await cacheSet(hash, routeJson, bucket, sessionId);

    // Если есть sessionId — создаём TrafficJob
    let trafficJobId: string | null = null;
    if (sessionId) {
      const job = await db.trafficJob.create({
        data: { sessionId, status: "pending" },
      });
      trafficJobId = job.id;
      await db.session.update({
        where: { id: sessionId },
        data: { trafficJobId: job.id },
      });
    }

    return json(
      { route, trafficJobId, cached: false },
      202,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Plan error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
