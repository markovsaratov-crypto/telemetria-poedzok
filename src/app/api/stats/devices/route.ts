// GET /api/stats/devices — топ устройств по активности (для dashboard leaderboard).
// Прямой SQL-запрос (один round-trip вместо N+1) — группировка по deviceId
// с агрегатами и последней сессией через коррелированный подзапрос.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const sql = `
      SELECT
        s.deviceId AS deviceId,
        (SELECT s2.deviceName FROM Session s2
         WHERE s2.deviceId = s.deviceId AND s2.deletedAt IS NULL
         ORDER BY s2.startTime DESC LIMIT 1) AS deviceName,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(s.pointCount), 0) AS totalPoints,
        COALESCE(SUM(s.payloadBytes), 0) AS totalBytes,
        MAX(s.startTime) AS lastActivity
      FROM Session s
      WHERE s.deletedAt IS NULL
      GROUP BY s.deviceId
      ORDER BY sessionCount DESC
      LIMIT 10
    `;
    const result = await libsql.execute(sql);
    const devices = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        deviceId: r.deviceId,
        deviceName: r.deviceName || null,
        sessionCount: Number(r.sessionCount) || 0,
        totalPoints: Number(r.totalPoints) || 0,
        totalBytes: Number(r.totalBytes) || 0,
        lastActivity: r.lastActivity || null,
      };
    });

    return json({ devices }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Devices stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
