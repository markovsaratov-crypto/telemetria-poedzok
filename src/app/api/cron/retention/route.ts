// POST /api/cron/retention — P1-10: подключение retention-cron (§3.7 спеки).
// Раньше runRetention() нигде не вызывался: grace-период и hard-delete не работали.
// Auth: Bearer CRON_SECRET или ?token=CRON_SECRET (middleware проверяет значение токена).
import { NextRequest } from "next/server";
import { runRetention } from "@/lib/retention";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const result = await runRetention();
    inc("retention_runs_total", "Retention cron runs", 1);
    logger.info("retention run", { requestId, ...result });
    return json({ ok: true, ...result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Retention error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
