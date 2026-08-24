// GET /api/stats/devices — топ устройств по активности (для dashboard leaderboard).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // Группировка по deviceId с агрегатами
    const devices = await db.session.groupBy({
      by: ["deviceId"],
      where: { deletedAt: null },
      _count: { id: true },
      _sum: { pointCount: true, payloadBytes: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    });

    // Для каждого устройства найдём последнюю сессию
    const result = await Promise.all(
      devices.map(async (d) => {
        const lastSession = await db.session.findFirst({
          where: { deviceId: d.deviceId, deletedAt: null },
          orderBy: { startTime: "desc" },
          select: { startTime: true, deviceName: true },
        });
        return {
          deviceId: d.deviceId,
          deviceName: lastSession?.deviceName || null,
          sessionCount: d._count.id,
          totalPoints: d._sum.pointCount || 0,
          totalBytes: d._sum.payloadBytes || 0,
          lastActivity: lastSession?.startTime || null,
        };
      })
    );

    return json({ devices: result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Devices stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
