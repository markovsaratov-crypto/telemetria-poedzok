// src/lib/warmup.ts — v2.39.0 (§A4, docs/OPTIMIZATION-PROPOSAL.md Вариант A):
// БЮДЖЕТНЫЙ ПРОГРЕВ после старта инстанса.
//
// ПРОБЛЕМА: Render free засыпает/рестартится — все in-memory кэши (trip-stats
// core cache, TTL-кэш статов, rollup-полнота) умирают; первый пользователь
// платит холодным пересчётом (полные конвейеры по сырым точкам = rows_read D1).
//
// РЕШЕНИЕ: fire-and-forget прогрев сразу после register(): топ-20 последних
// завершённых сессий (warmSessionCache — только тех, у кого кэш протух: меты
// читаются БЕЗ точек), топ-20 последних поездок (computeTripStats — существующий
// кэш-путь), rollup последних 7 дней (recomputeRollupRange), после чего первый
// poll /api/stats попадает в полный rollup (§A1) без тяжёлого COUNT.
//
// БЮДЖЕТ/БЕЗОПАСНОСТЬ (§A4):
//   • общий бюджет времени WARMUP_BUDGET_MS = 10 с — каждый шаг проверяет
//     остаток, превышение = тихий выход (прогрев довершат ленивые пути);
//   • env WARMUP_ENABLED (default "true");
//   • при исчерпанной квоте D1 любой шаг падает ошибкой — она ГЛОТАЕТСЯ с
//     warn-логом (прогрев обязан тихо деградировать, старт — не место для 500-х);
//   • вызывается ТОЛЬКО из instrumentation (Node.js runtime, не build-phase).

import { env } from "./env";
import { logger } from "./logger";
import { libsql } from "./db";
import { warmSessionCache } from "./session-cache";
import { loadSessionMetasWithCache, isSessionCacheFresh } from "./session-cache";
import { recomputeRollupRange, todayKey } from "./stats-rollup";
import { tripsEnabled } from "./trip-grouping";
import { loadTripById, computeTripStats } from "./trip-stats";

const WARMUP_BUDGET_MS = 10_000; // §A4: общий бюджет прогрева
const WARMUP_TOP_N = 20; // §A4: топ-N сессий/поездок
const WARMUP_ROLLUP_DAYS = 7; // §A4: rollup последних 7 дней

interface WarmupReport {
  enabled: boolean;
  sessionsWarmed: number;
  tripsWarmed: number;
  rollupRows: number;
  budgetSpentMs: number;
  steps: string[];
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}

/**
 * Прогрев кэшей после старта. НИКОГДА не бросает исключений наружу
 * (вызывается fire-and-forget из instrumentation.ts). Возвращает отчёт для
 * лога (юнит-тесты проверяют деградацию по бюджету).
 */
export async function runStartupWarmup(): Promise<WarmupReport> {
  const report: WarmupReport = {
    enabled: true,
    sessionsWarmed: 0,
    tripsWarmed: 0,
    rollupRows: 0,
    budgetSpentMs: 0,
    steps: [],
  };
  const start = Date.now();
  const deadline = start + WARMUP_BUDGET_MS;

  if (env().WARMUP_ENABLED !== "true") {
    report.enabled = false;
    report.steps.push("disabled by WARMUP_ENABLED");
    return report;
  }

  // ——— Шаг 1: rollup последних 7 дней (§A4; питает §A1-путь дашборда) ———
  try {
    const fromDay = new Date(Date.now() - WARMUP_ROLLUP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const res = await recomputeRollupRange(fromDay, todayKey(), "ALL", { withStatsCache: true });
    report.rollupRows = res.rowsWritten;
    report.steps.push(`rollup ${res.rowsWritten} rows/7d`);
  } catch (err) {
    // квота D1 исчерпана / шлюз 403 — тихо деградируем (§A4)
    report.steps.push("rollup skipped");
    logger.warn("warmup: rollup step failed (non-fatal, §A4)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ——— Шаг 2: топ-N завершённых сессий — прогрев только ПРОТУХШИХ кэшей ———
  try {
    const res = await libsql.execute({
      sql: `SELECT id FROM Session WHERE deletedAt IS NULL AND status = 'completed'
            ORDER BY startTime DESC LIMIT ${WARMUP_TOP_N}`,
    });
    const ids = (res.rows as Record<string, unknown>[]).map((r) => String(r.id));
    if (ids.length > 0) {
      // меты БЕЗ точек: свежий кэш → сессию не трогаем (точки не грузим — квота)
      const metas = await loadSessionMetasWithCache(ids, undefined, { stats: false, events: false, track: false });
      for (const id of ids) {
        if (remaining(deadline) <= 0) {
          report.steps.push("sessions: budget exhausted");
          break;
        }
        const meta = metas.get(id);
        if (meta && isSessionCacheFresh(meta)) continue; // кэш жив — прогрев не нужен
        try {
          await warmSessionCache(id); // грузит точки только реально нужных сессий
          report.sessionsWarmed++;
        } catch (err) {
          // одна битая сессия не останавливает прогрев остальных
          logger.warn("warmup: session warm failed (non-fatal, §A4)", {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    report.steps.push(`sessions ${report.sessionsWarmed}/${ids.length}`);
  } catch (err) {
    report.steps.push("sessions skipped");
    logger.warn("warmup: session step failed (non-fatal, §A4)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ——— Шаг 3: топ-N последних поездок (computeTripStats — кэш-путь) ———
  // Самый дорогой шаг (грузит точки поездок) — идёт последним, только при
  // остатке бюджета; TRIP_ENABLED=false → пропускается.
  if (tripsEnabled() && remaining(deadline) > 2_000) {
    try {
      const res = await libsql.execute({
        sql: `SELECT id FROM Trip WHERE deletedAt IS NULL ORDER BY spanStart DESC LIMIT ${WARMUP_TOP_N}`,
      });
      const ids = (res.rows as Record<string, unknown>[]).map((r) => String(r.id));
      for (const id of ids) {
        if (remaining(deadline) <= 0) {
          report.steps.push("trips: budget exhausted");
          break;
        }
        try {
          const trip = await loadTripById(id);
          if (trip == null) continue;
          await computeTripStats(trip);
          report.tripsWarmed++;
        } catch (err) {
          logger.warn("warmup: trip warm failed (non-fatal, §A4)", {
            tripId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      report.steps.push(`trips ${report.tripsWarmed}/${ids.length}`);
    } catch (err) {
      report.steps.push("trips skipped");
      logger.warn("warmup: trip step failed (non-fatal, §A4)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report.budgetSpentMs = Date.now() - start;
  logger.info("warmup done (§A4)", { ...report });
  return report;
}
