export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { computeSpeedDistribution, maxSpeedMs, meanPointSpeedMs } from "@/lib/kpi"; // P2-13
import { trackLatency } from "@/lib/latency"; // P2-16

// P2-13: единая схема бакетов §5.3 методологии (6 бакетов по 20 км/ч) — раньше API
// отдавал 4 бакета (0-20/20-40/40-60/60+), UI считал свои 7 (0-10…80+),
// а методология требует 6. Σ percent контролируется в kpi.ts (= 100).
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // §5.3: распределение включает стоянки (0-20 = «стоянка, пробка»),
    // поэтому speed >= 0 (раньше отсекали 0 — схема расходилась с методологией).
    // accuracy — для фильтра GPS-выбросов в kpi.ts.
    const res = await libsql.execute({
      sql: `SELECT g.speed AS speed, g.accuracy AS accuracy FROM GpsPoint g INNER JOIN Session s ON s.id = g.sessionId WHERE s.deletedAt IS NULL AND g.speed IS NOT NULL AND g.speed >= 0 LIMIT 200000`,
    });

    const points = res.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const speed = Number(row.speed);
      const accuracyRaw = row.accuracy;
      return {
        speed: Number.isFinite(speed) ? speed : null,
        accuracy: accuracyRaw == null ? null : Number(accuracyRaw),
      };
    });

    const { buckets, total } = computeSpeedDistribution(points);

    // P2-13: meanPointSpeed — средняя ПО ТОЧКАМ (для профиля); KPI AvgSpeed
    // (Distance/Duration §4.3) живёт в /api/stats/aggregate и /api/stats/[id].
    // avgSpeedMs/avgSpeedKmh сохранены как алиас meanPointSpeed для совместимости
    // старых клиентов, мобильный экран больше их не использует как KPI.
    const meanPoint = meanPointSpeedMs(points);
    const maxSpeed = maxSpeedMs(points) ?? 0;

    trackLatency(request); // P2-16: api_latency_p95

    return json({
      buckets, total,
      meanPointSpeedMs: meanPoint != null ? Math.round(meanPoint * 100) / 100 : null,
      meanPointSpeedKmh: meanPoint != null ? Math.round(meanPoint * 3.6 * 10) / 10 : null,
      avgSpeedMs: meanPoint != null ? Math.round(meanPoint * 100) / 100 : null,
      avgSpeedKmh: meanPoint != null ? Math.round(meanPoint * 3.6 * 10) / 10 : null,
      maxSpeedMs: maxSpeed,
      maxSpeedKmh: Math.round(maxSpeed * 3.6 * 10) / 10,
      maxBucketCount: Math.max(...buckets.map((b) => b.count), 1),
    }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Speed distribution error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
