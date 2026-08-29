// GET /api/stats — агрегированная статистика для dashboard (§3.x overview).
// Cookie или Bearer API_KEY.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // All-time stats
    const [totalSessions, totalPoints, totalRoutes, totalTrafficJobs, deadJobs, pendingJobs] = await Promise.all([
      db.session.count({ where: { deletedAt: null } }),
      db.gpsPoint.count(),
      db.route.count(),
      db.trafficJob.count(),
      db.trafficJob.count({ where: { status: "dead" } }),
      db.trafficJob.count({ where: { status: "pending" } }),
    ]);

    // Today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySessions = await db.session.count({
      where: { startTime: { gte: todayStart }, deletedAt: null },
    });

    // Last 7 days activity (for sparkline)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentSessions = await db.session.findMany({
      where: { startTime: { gte: sevenDaysAgo }, deletedAt: null },
      select: { startTime: true, endTime: true, pointCount: true, payloadBytes: true },
      orderBy: { startTime: "asc" },
    });

    // Per-day buckets for last 7 days
    // v2.9.4: +durationSec — сумма длительностей сессий за день (спарклайн KPI «Длительность» в мобильной аналитике)
    const perDay: { date: string; count: number; points: number; durationSec: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const dayItems = recentSessions.filter((s) => s.startTime >= d && s.startTime < next);
      perDay.push({
        date: d.toISOString().slice(0, 10),
        count: dayItems.length,
        points: dayItems.reduce((a, s) => a + s.pointCount, 0),
        durationSec: dayItems.reduce(
          (a, s) => a + Math.max(0, ((s.endTime ? new Date(s.endTime).getTime() : new Date(s.startTime).getTime()) - new Date(s.startTime).getTime()) / 1000),
          0
        ),
      });
    }

    // Total payload bytes
    const totalBytesResult = await db.session.aggregate({
      _sum: { payloadBytes: true },
      where: { deletedAt: null },
    });

    // Last 30 days heatmap
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 84); // 12 недель
    const heatmapSessions = await db.session.findMany({
      where: { startTime: { gte: thirtyDaysAgo }, deletedAt: null },
      select: { startTime: true, pointCount: true },
      orderBy: { startTime: "asc" },
    });

    return json(
      {
        totalSessions,
        totalPoints,
        totalRoutes,
        totalTrafficJobs,
        deadJobs,
        pendingJobs,
        todaySessions,
        totalPayloadBytes: totalBytesResult._sum.payloadBytes || 0,
        perDay,
        heatmapSessions: heatmapSessions.map((s) => ({
          startTime: s.startTime,
          pointCount: s.pointCount,
        })),
        // Capacity info (блокер №1 — отображение в UI)
        capacity: {
          targetLoadRpm: env().TARGET_LOAD_RPM,
          rateLimitMaxIngest: env().RATE_LIMIT_MAX_INGEST,
          headroom: env().RATE_LIMIT_MAX_INGEST - env().TARGET_LOAD_RPM,
        },
        version: env().APP_VERSION,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
