// GET /api/routes/grouped/export?format=csv — экспорт агрегатов routeHash-групп (v2.9.2).
// CSV с колонками: routeHash, topologyHash, sessionCount, avgActiveDurationSec,
// bestActiveDurationSec, worstActiveDurationSec, stdDevActiveDurationSec,
// avgDistanceM, firstSeen, lastSeen, deviceIds, sessionIds.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { listRouteGroups } from "@/lib/route-comparison";

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS = [
  "routeHash",
  "topologyHash",
  "sessionCount",
  "avgActiveDurationSec",
  "bestActiveDurationSec",
  "worstActiveDurationSec",
  "stdDevActiveDurationSec",
  "avgDistanceM",
  "firstSeen",
  "lastSeen",
  "deviceIds",
  "sessionIds",
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

    const groups = await listRouteGroups();
    const rows = groups.map((g) =>
      [
        g.routeHash,
        g.topologyHash ?? "",
        g.sessionCount,
        g.avgActiveDurationSec ?? "",
        g.bestActiveDurationSec ?? "",
        g.worstActiveDurationSec ?? "",
        g.stdDevActiveDurationSec ?? "",
        g.avgDistanceM ?? "",
        g.firstSeen,
        g.lastSeen,
        g.deviceIds.join("|"),
        g.sessionIds.join("|"),
      ]
        .map(csvEscape)
        .join(",")
    );
    const csv = [COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="route-groups-${stamp}.csv"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    logger.error("Route groups CSV export error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
