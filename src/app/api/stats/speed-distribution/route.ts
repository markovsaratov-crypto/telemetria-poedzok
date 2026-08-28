// GET /api/stats/speed-distribution — speed histogram buckets (0-20, 20-40, 40-60, 60+) km/h.
// Aggregates across all GPS points of all non-deleted sessions.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface Bucket {
  label: string;
  minKmh: number;
  maxKmh: number;
  count: number;
}

const BUCKETS: Bucket[] = [
  { label: "0-20", minKmh: 0, maxKmh: 20, count: 0 },
  { label: "20-40", minKmh: 20, maxKmh: 40, count: 0 },
  { label: "40-60", minKmh: 40, maxKmh: 60, count: 0 },
  { label: "60+", minKmh: 60, maxKmh: Infinity, count: 0 },
];

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    void db; // ensure db module loaded
    // Query GPS points joined to non-deleted sessions. We fetch speed values only.
    const res = await libsql.execute({
      sql: `SELECT g.speed AS speed
            FROM GpsPoint g
            INNER JOIN Session s ON s.id = g.sessionId
            WHERE s.deletedAt IS NULL AND g.speed IS NOT NULL AND g.speed >= 0
            LIMIT 100000`,
    });

    let total = 0;
    let maxSpeedMs = 0;
    let speedSum = 0;
    for (const row of res.rows) {
      const speedMs = Number((row as Record<string, unknown>).speed);
      if (!Number.isFinite(speedMs)) continue;
      total++;
      speedSum += speedMs;
      if (speedMs > maxSpeedMs) maxSpeedMs = speedMs;
      const kmh = speedMs * 3.6;
      for (const b of BUCKETS) {
        if (kmh >= b.minKmh && kmh < b.maxKmh) {
          b.count++;
          break;
        }
      }
    }

    const avgSpeedMs = total > 0 ? speedSum / total : null;
    const maxBucketCount = Math.max(...BUCKETS.map((b) => b.count), 1);

    return json(
      {
        buckets: BUCKETS.map((b) => ({
          label: b.label,
          minKmh: b.minKmh,
          maxKmh: b.maxKmh === Infinity ? null : b.maxKmh,
          count: b.count,
          percent: total > 0 ? Math.round((b.count / total) * 1000) / 10 : 0,
        })),
        total,
        avgSpeedMs: avgSpeedMs != null ? Math.round(avgSpeedMs * 100) / 100 : null,
        avgSpeedKmh: avgSpeedMs != null ? Math.round(avgSpeedMs * 3.6 * 100) / 100 : null,
        maxSpeedMs: Math.round(maxSpeedMs * 100) / 100,
        maxSpeedKmh: Math.round(maxSpeedMs * 3.6 * 100) / 100,
        maxBucketCount,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Speed distribution error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
