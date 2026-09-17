// POST /api/cron/finalize-sessions — финализирует recording-сессии, которые
// давно не обновлялись (порог — см. finalizeStaleMs ниже, v2.38.1 (ревью F8)).
// SensorLogger шлёт батчи каждые 1с; «запись закончена» канонически определяет
// ИНЖЕСТ (gap > SESSION_GAP_MS) — этот cron только страховка от зависших recording.
// Auth: Bearer CRON_SECRET ИЛИ ?token=CRON_SECRET (гейт proxy.ts требует
// CRON_SECRET для всех /api/cron/* — v2.18.0: принятые здесь ADMIN_TOKEN-ветки
// удалены как недостижимые: запрос с ADMIN_TOKEN отсекался ещё в proxy).
// v2.38.2 (ревью F44): GET — READ-ONLY (отчёт «что БУДЕТ финализировано»);
// мутация — только POST (крон render.yaml шлёт `curl -X POST` с v2.38.1).
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

// v2.38.1 (ревью F8): порог финализации cron — был захардкожен 60 000 мс по
// wall-clock (Session.updatedAt). Проблемы (находка F8):
//   1) СЕТЕВАЯ пауза >60 с (туннель/лифт/роуминг) — cron финализировал ЖИВУЮ
//      запись, следующий батч открывал НОВУЮ сессию — поездка резалась. Это
//      прямо отменяло фикс R4 v2.16.0 («61-секундный затык больше НЕ режет
//      поездку»: инжест склеивает по gap ≤ SESSION_GAP_MS).
//   2) В системе ТРИ финализатора с тремя порогами: 60 с cron / 60 с
//      SESSION_GAP_MS инжест / 10 мин «жнец» (STALE_RECORDING_TTL_MS в
//      worker-runtime.ts) — побеждал самый агрессивный (cron).
// Решение: порог cron ≥ порога «жнеца» (10 мин) с запасом к SESSION_GAP_MS
// (×10): max(10 мин, SESSION_GAP_MS × 10) — cron остаётся страховкой от
// зависших recording, а НЕ вторым gap-детектором. Окно настраивается env
// FINALIZE_STALE_MS (мс) без деплоя.
// Расчёт в хендлере (не на модуле): env() может бросить прод-инвариант —
// 500 роута честнее, чем падение загрузки модуля.
function finalizeStaleMs(): number {
  const fromEnv = Number(process.env.FINALIZE_STALE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(10 * 60_000, env().SESSION_GAP_MS * 10);
}

// v2.38.2 (ревью F44): аутентификация вынесена в хелпер — общая для GET
// (read-only) и POST (мутация). Возвращает 401-Response ИЛИ null (прошло).
async function cronAuth(request: NextRequest, requestId: string): Promise<Response | null> {
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
  return null;
}

// v2.38.2 (ревью F44): кандидаты финализации — read-only SELECT, общий для
// GET (отчёт «что будет») и POST (собственно финализация).
async function staleCandidates(staleMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const stale = await libsql.execute({
    sql: `SELECT id FROM Session
          WHERE status = 'recording' AND deletedAt IS NULL AND updatedAt < ?
          ORDER BY updatedAt ASC LIMIT 100`,
    args: [cutoff],
  });
  return stale.rows.map((row) => String((row as Record<string, unknown>).id));
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const unauthorized = await cronAuth(request, requestId);
    if (unauthorized) return unauthorized;

    const staleMs = finalizeStaleMs(); // v2.38.1 (F8): см. комментарий к finalizeStaleMs
    const candidates = await staleCandidates(staleMs);

    const finalized: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];
    for (const sessionId of candidates) {
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
      { ok: true, finalized: finalized.length, sessionIds: finalized, failed, cutoffMs: staleMs },
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

// v2.38.2 (ревью F44): GET — READ-ONLY. Раньше `export GET = POST`: GET
// финализировал сессии — префетчеры/мониторинг/healthchecks, дёргающие GET,
// мутировали БД. Теперь GET возвращает статистику «что БЫЛО бы финализировано
// при ближайшем POST» (та же аутентификация CRON_SECRET, тот же порог).
// Backward-compat: старые клиенты, звавшие GET ради финализации, получают
// 200 c readOnly:true и подсказкой про POST — НЕ 405, чтобы мониторинг
// не краснел; побочного эффекта у GET больше нет в принципе. Крон
// render.yaml шлёт `curl -X POST` ещё с v2.38.1 — изменений cron не нужно.
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const unauthorized = await cronAuth(request, requestId);
    if (unauthorized) return unauthorized;

    const staleMs = finalizeStaleMs(); // v2.38.1 (F8): см. комментарий к finalizeStaleMs
    const candidates = await staleCandidates(staleMs);

    return json(
      {
        ok: true,
        readOnly: true,
        wouldFinalize: candidates.length,
        sessionIds: candidates,
        cutoffMs: staleMs,
        hint: "GET is read-only; send POST with Bearer CRON_SECRET to finalize these sessions",
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Cron finalize-sessions GET error", {
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
