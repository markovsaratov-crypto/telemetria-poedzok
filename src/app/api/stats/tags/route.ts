// GET /api/stats/tags — агрегация всех тегов сессий для облака тегов.
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

    // Получаем все теги из сессий (tags хранятся как "tag1,tag2,tag3")
    const sessions = await db.session.findMany({
      where: {
        deletedAt: null,
        tags: { not: null },
      },
      select: { tags: true },
      // v2.11.0 (АУДИТ C-7): явный лимит вместо тихого дефолта 20
      take: 5000,
    });

    // Агрегируем теги
    const tagCounts = new Map<string, number>();
    for (const s of sessions) {
      if (!s.tags) continue;
      const tags = s.tags.split(",").map((t) => t.trim()).filter(Boolean);
      for (const t of tags) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }

    // Сортируем по count desc, затем alphabetically
    const tags = Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return json(
      {
        tags,
        total: tags.length,
        totalSessions: sessions.length,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Tags stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
