// GET /api/admin/alerts — P2-16: состояние правил AlertManager (§14.4 спеки).
// Auth: ADMIN_TOKEN (bearer) или сессионная cookie админа — гейтится middleware.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { evaluateAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const evaluation = await evaluateAlerts();
    return json(evaluation, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Alerts error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
