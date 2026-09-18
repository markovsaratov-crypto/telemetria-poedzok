// POST /api/worker/tick — одноразовый цикл инжест-воркера по HTTP (§B5 v2.40.0).
// Драйвер для Cron Triggers d1-gateway-воркера (Cloudflare): на рантаймах без
// долгоживущего интервала (Workers — eviction изолейтов) cron */1 вызывает
// этот роут; на Render in-process-интервал продолжает работать параллельно —
// атомарный claim (UPDATE…RETURNING + lockedBy) исключает двойную обработку.
// Авторизация: Bearer CRON_SECRET (scope "cron" — тот же канал, что у
// cron-эндпоинтов /api/cron/*; вызывает только планировщик шлюза).
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { runWorkerTick } from "@/lib/worker-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    const result = await runWorkerTick();
    return json({ ok: true, ...result }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("worker tick failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Worker tick failed" }, 500, { "X-Request-Id": requestId });
  }
}
