// POST /api/sessions/batch-stats — start/dest coords, distance, duration per session.
// Body: { ids: string[] }. Returns start/end (first/last GPS point), distanceM, durationSec.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { haversineM } from "@/lib/geo"; // P2-14: канонический гаверсинус (была локальная копия)

export const dynamic = "force-dynamic";

const zBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
});

interface SessionStatsOut {
  id: string;
  deviceId: string;
  deviceName: string | null;
  startTime: string;
  endTime: string | null;
  startLat: number | null;
  startLon: number | null;
  destLat: number | null;
  destLon: number | null;
  distanceM: number;
  durationSec: number;
  pointCount: number;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, {
        "X-Request-Id": requestId,
      });
    }
    const ids = parsed.data.ids;

    void db;

    // Fetch sessions
    const placeholders = ids.map(() => "?").join(",");
    const sessRes = await libsql.execute({
      sql: `SELECT id, deviceId, deviceName, startTime, endTime, pointCount
            FROM Session
            WHERE id IN (${placeholders}) AND deletedAt IS NULL`,
      args: ids,
    });

    const out: SessionStatsOut[] = [];
    for (const row of sessRes.rows) {
      const r = row as Record<string, unknown>;
      const id = String(r.id);
      // First/last GPS points
      const ptsRes = await libsql.execute({
        sql: `SELECT lat, lon, timestamp FROM GpsPoint
              WHERE sessionId = ?
              ORDER BY timestamp ASC`,
        args: [id],
      });
      const pts = ptsRes.rows as Array<Record<string, unknown>>;
      let distanceM = 0;
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        distanceM += haversineM(
          Number(p0.lat),
          Number(p0.lon),
          Number(p1.lat),
          Number(p1.lon)
        );
      }
      const start = pts[0];
      const dest = pts[pts.length - 1];
      const startMs = start ? Number(start.timestamp) : null;
      const endMs = dest ? Number(dest.timestamp) : null;
      const durationSec =
        startMs != null && endMs != null ? Math.max(0, (endMs - startMs) / 1000) : 0;

      out.push({
        id,
        deviceId: String(r.deviceId),
        deviceName: r.deviceName != null ? String(r.deviceName) : null,
        startTime: String(r.startTime),
        endTime: r.endTime != null ? String(r.endTime) : null,
        startLat: start ? Number(start.lat) : null,
        startLon: start ? Number(start.lon) : null,
        destLat: dest ? Number(dest.lat) : null,
        destLon: dest ? Number(dest.lon) : null,
        distanceM: Math.round(distanceM),
        durationSec: Math.round(durationSec),
        pointCount: Number(r.pointCount) || pts.length,
      });
    }

    return json({ sessions: out, total: out.length }, 200, {
      "X-Request-Id": requestId,
    });
  } catch (err) {
    logger.error("Batch stats error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
