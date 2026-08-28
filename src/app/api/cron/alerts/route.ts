// POST /api/cron/alerts — P2-16: периодическая оценка правил AlertManager (§14.4).
// Вызывается cron-сервисом Render каждые 5 минут (render.yaml: telemetria-alerts-cron).
// Auth: Bearer CRON_SECRET или ?token= (проверка значения — в middleware).
// При сработавших правилах шлёт уведомление в Slack (SLACK_WEBHOOK_URL, если задан)
// и увеличивает счётчик Prometheus alert_firing_total.
import { NextRequest } from "next/server";
import { evaluateAlerts, notifyFiring } from "@/lib/alerts";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc, set } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const evaluation = await evaluateAlerts();
    set("alert_firing_current", evaluation.firingCount, "Currently firing alert rules (§14.4)");
    const notified = await notifyFiring(evaluation);
    if (evaluation.firingCount > 0) {
      inc("alert_firing_total", "Alert rule evaluations that ended firing", 1);
      logger.warn("Alerts firing", {
        requestId,
        firingCount: evaluation.firingCount,
        notified,
        rules: evaluation.alerts.filter((a) => a.firing).map((a) => a.rule),
      });
    } else {
      logger.info("Alerts evaluated: all clear", { requestId });
    }
    return json({ ok: true, ...evaluation, notified }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Alerts cron error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
