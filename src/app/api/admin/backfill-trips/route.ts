// POST /api/admin/backfill-trips — v2.26.0 (ТЗ «Поездка не рвётся», §13):
// детерминированный backfill истории в поездки. recomputeTripsForDevice по
// ВСЕМ устройствам (единый код правила, инкрементальное назначение ≡ backfill);
// идемпотентен (повтор = no-op diff: существующие поездки матчатся по окну).
// План-джобы ставятся ТОЛЬКО за последние 30 дней (квоты 2ГИС, §13 ТЗ п.3);
// старше — лениво при открытии поездки (requeue-админом или повтором с days).
//
// Auth: Bearer ADMIN_TOKEN / admin-cookie. admin:heavy-скоп (1/час POST).
// Аудит: действие trip.backfill (§14 ТЗ).
import { NextRequest } from "next/server";
import { z } from "zod";
import { libsql } from "@/lib/db";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";
import { recomputeTripsForDevice, tripsEnabled } from "@/lib/trip-grouping";

const zBackfillBody = z.object({
  /** Сколько последних дней получают план-джобы (квоты 2ГИС). Default 30. */
  planDays: z.coerce.number().int().min(0).max(3650).optional(),
});

const PLAN_DAYS_DEFAULT = 30;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });
    if (!tripsEnabled()) {
      return json({ error: "TRIP_ENABLED=false — включите поездки перед backfill (§13 ТЗ)" }, 409, { "X-Request-Id": requestId });
    }

    const body = await request.json().catch(() => ({}));
    const parsed = zBackfillBody.safeParse(body ?? {});
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const planDays = parsed.data.planDays ?? PLAN_DAYS_DEFAULT;

    // Все устройства с живыми записями
    const devicesRes = await libsql.execute({
      sql: `SELECT deviceId, COUNT(*) AS cnt FROM Session WHERE deletedAt IS NULL GROUP BY deviceId ORDER BY cnt DESC`,
    });
    const devices = (devicesRes.rows as Record<string, unknown>[]).map((r) => String(r.deviceId));

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let processed = 0;
    for (const deviceId of devices) {
      // Полная история устройства (0 = с начала) — детерминированный recompute
      const res = await recomputeTripsForDevice(deviceId, 0, { requestId });
      created += res.created;
      updated += res.updated;
      deleted += res.deleted;
      processed++;
      inc("trip_backfill_processed_total", "Devices backfilled", 1);
    }

    // План-джобы за последние N дней: поездкам без живого джоба — pending
    const planCutoff = new Date(Date.now() - planDays * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const noJobsRes = await libsql.execute({
      sql: `SELECT t.id FROM Trip t
            WHERE t.deletedAt IS NULL AND t.spanStart >= ?
              AND NOT EXISTS (SELECT 1 FROM TrafficJob j WHERE j.tripId = t.id AND j.status IN ('pending', 'running', 'completed'))`,
      args: [planCutoff],
    });
    const planJobs: Array<{ sql: string; args: unknown[] }> = [];
    for (const r of noJobsRes.rows as Record<string, unknown>[]) {
      const tripId = String(r.id);
      planJobs.push({
        sql: `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
              VALUES (?, ?, 'pending', 0, 0, ?, ?)`,
        args: [crypto.randomUUID(), tripId, now, now],
      });
    }
    // Проставляем trafficJobId последним вставленным джобом (trafficJobId был NULL)
    if (planJobs.length > 0) {
      await libsql.batch(planJobs.map((s) => ({ sql: s.sql, args: s.args as never[] })));
      await libsql.execute({
        sql: `UPDATE Trip SET trafficJobId = (
                SELECT id FROM TrafficJob WHERE tripId = Trip.id ORDER BY createdAt DESC LIMIT 1)
              WHERE trafficJobId IS NULL AND deletedAt IS NULL AND spanStart >= ?`,
        args: [planCutoff],
      });
    }

    const summary = {
      ok: true,
      devices: processed,
      tripsCreated: created,
      tripsUpdated: updated,
      tripsDeleted: deleted,
      planJobsQueued: noJobsRes.rows.length,
      planDays,
      idempotent: true,
    };

    await writeAudit({
      action: "trip.backfill",
      targetId: "all-devices",
      targetType: "Trip",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"),
      metadata: summary,
    });
    logger.info("trip backfill completed", { requestId, ...summary });
    return json(summary, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Trip backfill error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
