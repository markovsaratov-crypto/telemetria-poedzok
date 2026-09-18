// POST /api/admin/backfill-rollup — v2.39.0 (§A1.7, docs/OPTIMIZATION-PROPOSAL.md
// Вариант A): пересчёт StatsRollup за диапазон дат из Session (полный
// идемпотентный пересчёт «истина из Session»: SUM(pointCount), COUNT(*),
// дистанция/длительность/эко — из statsCache). О(числа сессий) — таблица точек
// не читается вовсе (главное условие задачи — не жечь квоту D1 бэкфиллом).
//
// Auth: Bearer ADMIN_TOKEN / admin-cookie (admin:heavy-скоп 1/час, как
// backfill-trips). Аудит: действие stats.rollup_backfill (§14 ТЗ).
// Тело: {from: "YYYY-MM-DD", to: "YYYY-MM-DD"} — оба обязательны; диапазон
// ≤ 92 дней (защита от случайного «пересчитай всё» тяжёлым запросом; полная
// история закрывается вызовами по кварталам или фоновым heal'ом §A1.4).
import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";
import { recomputeRollupRange, todayKey } from "@/lib/stats-rollup";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

const zBackfillBody = z.object({
  from: z.string().regex(DAY_RE, "from must be YYYY-MM-DD"),
  to: z.string().regex(DAY_RE, "to must be YYYY-MM-DD"),
  /** true — пересчитать только хозяйские (unclaimed) строки; по умолчанию все владельцы. */
  ownerOnly: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => ({}));
    const parsed = zBackfillBody.safeParse(body ?? {});
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const { from, to, ownerOnly } = parsed.data;

    // Лимит диапазона (§A1.7): ≤ 92 дней и from ≤ to; «to» в будущем бессмыслен
    // (сессий будущего нет) — клипим к сегодня, дни без сессий не пишутся.
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return json({ error: "Invalid date" }, 400, { "X-Request-Id": requestId });
    }
    const rangeDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
    if (rangeDays <= 0) {
      return json({ error: `from (${from}) must be <= to (${to})` }, 400, { "X-Request-Id": requestId });
    }
    if (rangeDays > MAX_RANGE_DAYS) {
      return json(
        { error: `Range too large: ${rangeDays} days > ${MAX_RANGE_DAYS}. Разбейте на несколько вызовов.` },
        400,
        { "X-Request-Id": requestId }
      );
    }
    const toClamped = to > todayKey() ? todayKey() : to;

    const owner = ownerOnly ? null : "ALL";
    const result = await recomputeRollupRange(from, toClamped, owner, { withStatsCache: true });
    inc("stats_rollup_backfill_rows_total", "StatsRollup rows rewritten by admin backfill", result.rowsWritten);

    const summary = {
      ok: true,
      from,
      to: toClamped,
      days: Math.max(1, rangeDays),
      rowsWritten: result.rowsWritten,
      owner: owner === "ALL" ? "all" : "unclaimed",
      idempotent: true, // повтор вызова = та же «истина из Session» (UPSERT-перезапись)
    };

    await writeAudit({
      action: "stats.rollup_backfill",
      targetId: `${from}..${toClamped}`,
      targetType: "StatsRollup",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"),
      metadata: summary,
    });
    logger.info("stats rollup backfill completed", { requestId, ...summary });
    return json(summary, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Stats rollup backfill error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
