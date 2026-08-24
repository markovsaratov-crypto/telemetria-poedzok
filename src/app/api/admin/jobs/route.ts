// GET /api/admin/jobs — список TrafficJob для admin panel (§4.9 admin view).
// Query: ?status=pending|running|failed|dead|completed&limit=50
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const jobs = await db.trafficJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        sessionId: true,
        status: true,
        attempts: true,
        lockedBy: true,
        lockedAt: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        scheduledFor: true,
        session: { select: { deviceId: true, startTime: true } },
      },
    });

    // Summary counts
    const counts = await db.trafficJob.groupBy({
      by: ["status"],
      _count: true,
    });
    const summary: Record<string, number> = {};
    for (const c of counts) summary[c.status] = c._count;

    return json({ jobs, summary, total: jobs.length }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Admin jobs error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
