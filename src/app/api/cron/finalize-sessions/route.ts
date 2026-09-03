// POST /api/cron/finalize-sessions — финализирует recording-сессии, которые не обновлялись > 60с.
// SensorLogger шлёт батчи каждые 1с; если батчей нет 60с — запись закончена.
// Auth: Bearer CRON_SECRET ИЛИ ?token=CRON_SECRET (гейт proxy.ts требует
// CRON_SECRET для всех /api/cron/* — v2.18.0: принятые здесь ADMIN_TOKEN-ветки
// удалены как недостижимые: запрос с ADMIN_TOKEN отсекался ещё в proxy).
// v2.16.0 (V1-ingest): ДУБЛИРОВАННАЯ реализация finalizeOne УДАЛЕНА — роут
// использует общий session-finalize.ts (как инжест и воркер-«жнец»).
// v2.18.0 (P1): пер-итем try/catch. Раньше один падающий UPDATE прерывал весь
// батч (500, до 99 сессий не финализированы), а кандидат с упорным сбоем
// оставался в голове очереди (ORDER BY updatedAt ASC) и ГЛОДИЛ каждый
// следующий запуск — лайвнесс-клин всей финализации.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { extractBearer } from "@/lib/auth";
import { tokenMatches } from "@/lib/token-check"; // AUDIT B-16: timing-safe сравнение
import { env } from "@/lib/env";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { finalizeSession } from "@/lib/session-finalize";

const STALE_MS = 60_000; // 60с без батча = запись закончена

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    const bearer = extractBearer(request);
    const e = env();
    // AUDIT B-16: timing-safe сравнение (раньше ===)
    const tokenOk =
      (await tokenMatches(bearer, e.CRON_SECRET)) ||
      (await tokenMatches(queryToken, e.CRON_SECRET));
    if (!tokenOk) {
      return json({ error: "Unauthorized" }, 401, { "X-Request-Id": requestId });
    }

    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const stale = await libsql.execute({
      sql: `SELECT id FROM Session
            WHERE status = 'recording' AND deletedAt IS NULL AND updatedAt < ?
            ORDER BY updatedAt ASC LIMIT 100`,
      args: [cutoff],
    });

    const finalized: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];
    for (const row of stale.rows) {
      const sessionId = (row as Record<string, unknown>).id as string;
      try {
        await finalizeSession(sessionId);
        finalized.push(sessionId);
      } catch (err) {
        // Изоляция сбоя: остальные сессии батча финализируются, сбойная — в отчёт
        // (и в логи с sessionId — репетиция идёт по ORDER BY updatedAt ASC,
        // чтобы упорный сбой не блокировал хвост очереди вечно).
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ sessionId, error: msg });
        logger.error("finalize-sessions: per-item failure", { requestId, sessionId, error: msg });
      }
    }

    if (finalized.length > 0) {
      logger.info("Cron finalize-sessions", { count: finalized.length, sessionIds: finalized });
    }
    return json(
      { ok: true, finalized: finalized.length, sessionIds: finalized, failed, cutoffMs: STALE_MS },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Cron finalize-sessions error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    // v2.16.0 (B16): наружу — без деталей (только в логах), как остальные роуты
    return json(
      { error: "Internal Server Error" },
      500,
      { "X-Request-Id": requestId }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
