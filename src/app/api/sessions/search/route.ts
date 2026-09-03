// GET /api/sessions/search?q=text — глобальный поиск по deviceId, notes, tags.
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

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    // v2.16.0 (B6): ?limit=abc больше НЕ даёт NaN (NaN → take: NaN → 500 от libsql)
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;

    if (!q) {
      return json({ sessions: [], query: "" }, 200, { "X-Request-Id": requestId });
    }

    // Поиск по deviceId, notes, tags (contains; v2.16.0: LOWER-LIKE — регистр
    // игнорируется и для кириллицы, matchFields — тем же правилом)
    const qLower = q.toLowerCase();
    const sessions = await db.session.findMany({
      where: {
        deletedAt: null,
        OR: [
          { deviceId: { contains: q } },
          { deviceName: { contains: q } },
          { notes: { contains: q } },
          { tags: { contains: q } },
        ],
      },
      orderBy: { startTime: "desc" },
      take: limit,
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        payloadBytes: true,
        status: true,
        notes: true,
        tags: true,
      },
    });

    // Подсветка совпадений (v2.16.0: регистронезависимо — как SQL-фильтр выше)
    const highlighted = sessions.map((s) => {
      const matchFields: string[] = [];
      if (s.deviceId?.toLowerCase().includes(qLower)) matchFields.push("deviceId");
      if (s.deviceName?.toLowerCase().includes(qLower)) matchFields.push("deviceName");
      if (s.notes?.toLowerCase().includes(qLower)) matchFields.push("notes");
      if (s.tags?.toLowerCase().includes(qLower)) matchFields.push("tags");
      return { ...s, matchFields };
    });

    return json({ sessions: highlighted, query: q, total: highlighted.length }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Search error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
