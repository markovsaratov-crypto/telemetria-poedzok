// POST /api/cron/retention — P1-10: подключение retention-cron (§3.7 спеки).
// Раньше runRetention() нигде не вызывался: grace-период и hard-delete не работали.
// Auth: Bearer CRON_SECRET или ?token=CRON_SECRET (middleware проверяет значение токена).
import { NextRequest } from "next/server";
import { runRetention } from "@/lib/retention";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { env } from "@/lib/env";
import { tokenMatches } from "@/lib/token-check";
import { extractBearer } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    // v2.29.0 (MI-13 кодревью): in-route auth (defense in depth, как в
    // finalize-sessions) — retention ДЕСТРУКТИВЕН (hard-delete), одного
    // прокси-гейта мало: прямой вызов роута в обход proxy/middleware
    // (другой ingress, future refactor) не должен запускать purge.
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    const bearer = extractBearer(request);
    const e = env();
    const tokenOk =
      (await tokenMatches(bearer, e.CRON_SECRET)) ||
      (await tokenMatches(queryToken, e.CRON_SECRET));
    if (!tokenOk) {
      return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
    }
    const result = await runRetention();
    inc("retention_runs_total", "Retention cron runs", 1);
    logger.info("retention run", { requestId, ...result });
    return json({ ok: true, ...result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Retention error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
