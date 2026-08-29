// GET /api/sessions/export?format=csv — экспорт списка сессий (v2.9.3).
// CSV с колонками: id, status, deviceName, deviceId, startTime, endTime, pointCount,
// payloadBytes, routeHash, topologyHash, trafficProvider, planDistanceM, planDurationSec.
// План-факт (distance/duration) — из последнего завершённого TrafficJob сессии.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS = [
  "id",
  "status",
  "deviceName",
  "deviceId",
  "startTime",
  "endTime",
  "pointCount",
  "payloadBytes",
  "routeHash",
  "topologyHash",
  "trafficProvider",
  "planDistanceM",
  "planDurationSec",
] as const;

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const format = request.nextUrl.searchParams.get("format")?.toLowerCase() || "csv";
    if (format !== "csv") {
      return json({ error: "Unsupported format", reason: `format=${format}` }, 400, { "X-Request-Id": requestId });
    }

    const sessions = await db.session.findMany({
      where: { deletedAt: null },
      orderBy: { startTime: "desc" },
      take: 10000,
      select: {
        id: true,
        status: true,
        deviceName: true,
        deviceId: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        routeHash: true,
        topologyHash: true,
      },
    });

    // План-факт: последний завершённый TrafficJob на сессию
    const jobBySession = new Map<string, { provider: string | null; distanceM: number | null; durationSec: number | null }>();
    try {
      const jobs = await libsql.execute(
        "SELECT sessionId, result FROM TrafficJob WHERE status = 'completed' AND result IS NOT NULL ORDER BY updatedAt ASC"
      );
      for (const row of jobs.rows as Array<Record<string, unknown>>) {
        const sid = String(row.sessionId ?? "");
        if (!sid) continue;
        try {
          const parsed = JSON.parse(String(row.result)) as { provider?: string; distanceM?: number; durationSec?: number };
          jobBySession.set(sid, {
            provider: parsed.provider ? String(parsed.provider) : null,
            distanceM: typeof parsed.distanceM === "number" ? Math.round(parsed.distanceM) : null,
            durationSec: typeof parsed.durationSec === "number" ? Math.round(parsed.durationSec) : null,
          });
        } catch {
          // skip unparseable
        }
      }
    } catch {
      // TrafficJob-обвязка недоступна — экспорт без план-факта
    }

    const header = COLUMNS.join(",");
    const lines = sessions.map((s: Record<string, unknown>) => {
      const job = jobBySession.get(String(s.id));
      return [
        s.id,
        s.status,
        s.deviceName,
        s.deviceId,
        s.startTime instanceof Date ? s.startTime.toISOString() : s.startTime,
        s.endTime instanceof Date ? s.endTime.toISOString() : s.endTime,
        s.pointCount,
        s.payloadBytes,
        s.routeHash,
        s.topologyHash,
        job?.provider,
        job?.distanceM,
        job?.durationSec,
      ]
        .map(csvEscape)
        .join(",");
    });

    const csv = header + "\r\n" + lines.join("\r\n") + "\r\n";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sessions-${ts}.csv"`,
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    logger.error("Sessions export error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
