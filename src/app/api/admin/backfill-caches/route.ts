// POST /api/admin/backfill-caches — v2.41.0 (P0-B, N-8): бюджетный
// офлайн-пересчёт протухших кэш-payload'ов сессий ДО первого зрителя.
//
// ЗАЧЕМ: с v2.41.0 свежесть кэш-поля проверяется по ШТАМПУ КОНВЕЙЕРА в
// payload (cacheV). Все payload'ы, записанные ДО v2.41.0, штампа не несут
// (версия 0) → честно «протухшие». Если пустить это на «первого зрителя»,
// первое открытие дашборда пересчитает ~50 сессий сразу — повторение
// квота-инцидента N-6 (урок v2.40.7: глобальный bump сжёг 300–450 тыс.
// строк). Этот роут проходит те же сессии ФОНОМ, по бюджету, с аварийным
// стопом по квота-ошибке D1.
//
// БЮДЖЕТ: инвентарь — ОДИН SELECT по Session (~104 строки rows_read;
// JSON-колонки не размножают rows_read). Пересчёт сессии — её точки
// (~59 тыс. суммарно на проде сентября) + 8 параллельных UPDATE.
// Полный проход ≈ 80–100 тыс. rows_read ≈ 2% дневной квоты (замер Task 28).
//
// Идемпотентен: повтор = пересчёт только тех, кто остался протухшим
// (detectStaleCacheFields). Активные recording-сессии исключены (их кэш
// протухает каждым батчем инжеста — греть бессмысленно).
//
// Auth: Bearer ADMIN_TOKEN / admin-cookie. admin:heavy-скоп (1/час POST,
// бакет на токен+путь — не блокирует бэкапы). Аудит: действие cache.backfill.
import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { inc } from "@/lib/metrics";
import { isD1QuotaError } from "@/lib/d1-quota";
import { findSessionsWithStalePayloads, warmSessionCache } from "@/lib/session-cache";

const zBackfillBody = z.object({
  /** Максимум сессий на вызов (бюджет CPU Render 0.1). Default 60. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Бюджет времени на вызов, мс. Default 45 000 (запрос живёт ~60 с). */
  budgetMs: z.coerce.number().int().min(5_000).max(55_000).optional(),
});

const LIMIT_DEFAULT = 60;
const BUDGET_MS_DEFAULT = 45_000;

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
    const limit = parsed.data.limit ?? LIMIT_DEFAULT;
    const budgetMs = parsed.data.budgetMs ?? BUDGET_MS_DEFAULT;

    // ——— инвентарь протухших (один SELECT, ~строка rows_read на сессию) ———
    const startedAt = Date.now();
    const inventory = await findSessionsWithStalePayloads(200);
    const toWarm = inventory.ids.slice(0, limit);
    const remaining = Math.max(0, inventory.ids.length - toWarm.length);

    let warmed = 0;
    let quotaHit = false;
    let reason = "completed";
    for (const id of toWarm) {
      if (Date.now() - startedAt >= budgetMs) {
        reason = "budget exhausted — повторите вызов для остатка";
        break;
      }
      try {
        await warmSessionCache(id);
        warmed++;
      } catch (err) {
        if (isD1QuotaError(err)) {
          // АВАРИЙНЫЙ СТОП: остаток бюджета не тратим в стену (как N-6 warm)
          quotaHit = true;
          reason = "D1 quota error — прогрев остановлен, остаток пересчитается on-demand";
          break;
        }
        logger.warn("backfill-caches: session warm failed (skip)", {
          requestId, id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = {
      ok: true,
      scanned: inventory.scanned,
      staleFound: inventory.ids.length,
      warmed,
      remaining,
      quotaHit,
      budgetSpentMs: Date.now() - startedAt,
      reason,
      idempotent: true,
    };
    inc("cache_backfill_warmed_total", "Sessions cache-warmed by backfill-caches (v2.41.0 P0-B)", warmed);

    await writeAudit({
      action: "cache.backfill",
      targetId: "stale-session-caches",
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: (await getUserIdFromRequest(request)) ?? (auth.via === "cookie" ? "owner" : "admin-token"),
      metadata: summary,
    });
    logger.info("cache backfill completed", { requestId, ...summary });
    return json(summary, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Cache backfill error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
