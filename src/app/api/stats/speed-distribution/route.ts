export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

const BUCKETS = [
  { label: "0-20", minKmh: 0, maxKmh: 20 },
  { label: "20-40", minKmh: 20, maxKmh: 40 },
  { label: "40-60", minKmh: 40, maxKmh: 60 },
  { label: "60+", minKmh: 60, maxKmh: Infinity },
];

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // Methodology: only speed > 0 (active part, exclude stops)
    const res = await libsql.execute({
      sql: `SELECT g.speed AS speed FROM GpsPoint g INNER JOIN Session s ON s.id = g.sessionId WHERE s.deletedAt IS NULL AND g.speed IS NOT NULL AND g.speed > 0 LIMIT 100000`,
    });

    let total = 0, maxSpeedMs = 0, speedSum = 0;
    const counts = [0, 0, 0, 0];

    for (const row of res.rows) {
      const speedMs = Number((row as Record<string, unknown>).speed);
      if (!Number.isFinite(speedMs) || speedMs <= 0) continue;
      total++;
      speedSum += speedMs;
      if (speedMs > maxSpeedMs) maxSpeedMs = speedMs;
      const kmh = speedMs * 3.6;
      // Strict: find FIRST matching bucket and break (no double counting)
      for (let i = 0; i < BUCKETS.length; i++) {
        if (i === BUCKETS.length - 1) {
          // Last bucket (60+): match if kmh >= minKmh
          if (kmh >= BUCKETS[i].minKmh) { counts[i]++; break; }
        } else if (kmh >= BUCKETS[i].minKmh && kmh < BUCKETS[i].maxKmh) {
          counts[i]++;
          break;
        }
      }
    }

    const buckets = BUCKETS.map((b, i) => ({
      label: b.label, minKmh: b.minKmh, maxKmh: b.maxKmh === Infinity ? null : b.maxKmh,
      count: counts[i],
      percent: total > 0 ? Math.round((counts[i] / total) * 1000) / 10 : 0,
    }));

    const avgSpeedMs = total > 0 ? Math.round((speedSum / total) * 100) / 100 : null;
    const maxBucketCount = Math.max(...counts, 1);

    return json({
      buckets, total,
      avgSpeedMs,
      avgSpeedKmh: avgSpeedMs != null ? Math.round(avgSpeedMs * 3.6 * 10) / 10 : null,
      maxSpeedMs,
      maxSpeedKmh: Math.round(maxSpeedMs * 3.6 * 10) / 10,
      maxBucketCount,
    }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Speed distribution error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
