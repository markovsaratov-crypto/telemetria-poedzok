export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

interface Bucket {
  label: string;
  minKmh: number;
  maxKmh: number | null;
  count: number;
  percent: number;
}

const BUCKETS: Bucket[] = [
  { label: "0-20", minKmh: 0, maxKmh: 20, count: 0, percent: 0 },
  { label: "20-40", minKmh: 20, maxKmh: 40, count: 0, percent: 0 },
  { label: "40-60", minKmh: 40, maxKmh: 60, count: 0, percent: 0 },
  { label: "60+", minKmh: 60, maxKmh: null, count: 0, percent: 0 },
];

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // Query GPS points: only speed > 0 (methodology: active part only, exclude stops)
    const res = await libsql.execute({
      sql: `SELECT g.speed AS speed
            FROM GpsPoint g
            INNER JOIN Session s ON s.id = g.sessionId
            WHERE s.deletedAt IS NULL AND g.speed IS NOT NULL AND g.speed > 0
            LIMIT 100000`,
    });

    let total = 0;
    let maxSpeedMs = 0;
    let speedSum = 0;
    for (const row of res.rows) {
      const speedMs = Number((row as Record<string, unknown>).speed);
      if (!Number.isFinite(speedMs) || speedMs <= 0) continue;
      total++;
      speedSum += speedMs;
      if (speedMs > maxSpeedMs) maxSpeedMs = speedMs;
      const kmh = speedMs * 3.6;
      for (const b of BUCKETS) {
        if (b.maxKmh === null) {
          if (kmh >= b.minKmh) { b.count++; break; }
        } else if (kmh >= b.minKmh && kmh < b.maxKmh) {
          b.count++;
          break;
        }
      }
    }

    // Fix percentages to sum to 100%
    for (const b of BUCKETS) {
      b.percent = total > 0 ? Math.round((b.count / total) * 1000) / 10 : 0;
    }

    const avgSpeedMs = total > 0 ? Math.round((speedSum / total) * 100) / 100 : null;
    const maxBucketCount = Math.max(...BUCKETS.map((b) => b.count), 1);

    return json({
      buckets: BUCKETS,
      total,
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
