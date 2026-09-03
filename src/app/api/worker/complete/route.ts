// POST /api/worker/complete — Worker отдаёт результат обработки TrafficJob
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";

// v2.11.0 (АУДИТ C-27): статус валидируется zod-енамом — раньше любой мусор
// ("banana") писался в БД и ломал семантику пайплайна.
const zCompleteBody = z.object({
  jobId: z.string().min(1),
  status: z.enum(["completed", "failed", "dead"]),
  result: z.unknown().optional(),
  error: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zCompleteBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const { jobId, status, result, error } = parsed.data;

    const job = await db.trafficJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });

    // v2.16.0 (S4): проверка владения и статуса — complete/failed/dead можно
    // применить ТОЛЬКО к running-джобу этого воркера. Раньше любой держатель
    // CRON_SECRET мог произвольно перезаписать любой джоб (даже pending).
    if (job.status !== "running") {
      return json({ error: `Job is not running (status=${job.status}) — complete is not applicable` }, 409, { "X-Request-Id": requestId });
    }

    const attempts = job.attempts + 1;
    const updateData: Record<string, unknown> = {
      status,
      attempts,
      updatedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    };
    if (status === "completed") {
      updateData.result = result ? JSON.stringify(result) : null;
      inc("traffic_job_completed_total", "Traffic jobs completed", 1);

      // v2.9: персист routeHash + topologyHash в Session, если они вычислены ворчером
      // (см. mini-services/worker/processor.ts → computeRouteHash §10.0).
      if (result && typeof result === "object") {
        const r = result as { routeHash?: string | null; topologyHash?: string | null };
        if (r.routeHash || r.topologyHash) {
          const sessionUpdate: Record<string, unknown> = { updatedAt: new Date() };
          if (r.routeHash) {
            sessionUpdate.routeHash = r.routeHash;
            inc("route_id_assignments_total", "routeId (routeHash) assignments via worker", 1);
          }
          if (r.topologyHash) sessionUpdate.topologyHash = r.topologyHash;
          await db.session.update({
            where: { id: job.sessionId },
            data: sessionUpdate,
          }).catch((err) => {
            logger.warn("Failed to persist routeHash/topologyHash on session (non-fatal)", {
              requestId,
              sessionId: job.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        // v2.9: метрика HMM map matching
        if ("mapMatchLogProb" in r && typeof r.mapMatchLogProb === "number" && isFinite(r.mapMatchLogProb)) {
          inc("hmm_mapmatching_runs_total", "HMM map matching runs in worker", 1);
        }
      }
    } else if (status === "failed") {
      updateData.error = error || "unknown";
      inc("traffic_job_failed_total", "Traffic jobs failed", 1);
      // Если attempts < 3 — requeue с backoff (v2.16.0 (V6): backoffMs — так и
      // называем; error сохраняется в поле — раньше стирался в null, диагностика
      // «failed»-ретраев терялась)
      if (attempts < 3) {
        const backoffMs = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
        updateData.status = "pending";
        updateData.scheduledFor = new Date(Date.now() + backoffMs);
      } else {
        updateData.status = "dead";
      }
    } else if (status === "dead") {
      updateData.error = error || "max attempts exceeded";
    }

    await db.trafficJob.update({ where: { id: jobId }, data: updateData });
    return json({ ok: true, jobId, status: updateData.status, attempts }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker complete error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
