// src/lib/gateway-budget.ts — v2.41.0 (P1, m-21 «двойной учёт квоты»):
// АВТОРИТЕТНЫЙ дневной бюджет D1 из KV-метра шлюза d1-gateway.
//
// ПРОБЛЕМА (m-21, замер Task 28): счётчик ПРИЛОЖЕНИЯ d1_rows_read_total
// (db-d1.ts) расходится с реальностью — он (а) умирает с каждым ресайклом
// Render free (2 за 40 минут 20.09), (б) не видит чтений ДРУГИХ изолейтов
// шлюза (cron-tick, backup drill, канарейка) — 4,49 млн «за эпоху» против
// 510 тыс. реальных «за сегодня». /health и тайл «Качество данных» рисовали
// параллельную реальность.
//
// РЕШЕНИЕ: шлюз СЧИТАЕТ КАЖДЫЙ ответ D1 (Pack C v2.40.9, §P1-a) и
// троттл-флашит сумму в KV-ключ дня `quota:day:YYYY-MM-DD`:
// { rowsRead, rowsWritten, quotaExhaustedAt }. Читаем его напрямую через
// POST /kvstore/get (тот же паттерн, что routes-hotspot-cache.ts):
//   • кэш 30 с в памяти (опрос /health 30 с + DataQuality — не более
//     2 880 чтений KV-канала в сутки, KV-читы бесплатны для квоты D1);
//   • НЕ-fatal: канал упал/воркер старой версии → null (потребители
//     честно показывают «метр недоступен», sticky-флаги m-20 остаются);
//   • сутки считаются ПО UTC шлюзом (сброс 00:00 UTC) — ключ дня здесь
//     строится по UTC, как в d1-gateway.js budgetDayKey().
//
// Модуль почти лист: logger + metrics; никакого импорта db-транспорта.

import { logger } from "./logger";

/** Лимит free-плана D1 (зеркало BUDGET_DAILY_READ_LIMIT шлюза). */
export const D1_DAILY_READ_LIMIT = 5_000_000;

export interface GatewayDayBudget {
  day: string;
  rowsRead: number;
  rowsWritten: number;
  quotaExhaustedAt: string | null;
  readPct: number;
}

const MEM_TTL_MS = 30_000;
const KVSTORE_TIMEOUT_MS = 8_000;
const GLOBAL_KEY = "__telematGatewayDayBudget";
const g = globalThis as unknown as { [GLOBAL_KEY]?: { value: GatewayDayBudget | null; at: number } };

function dayKeyUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function gatewayBase(): { url: string; secret: string } | null {
  const url = (process.env.D1_GATEWAY_URL ?? "").replace(/\/$/, "");
  const secret = process.env.D1_GATEWAY_SECRET ?? "";
  return url && secret ? { url, secret } : null;
}

/**
 * Дневной бюджет D1 из метра шлюза (KV-ключ quota:day:<UTC-дата>).
 * null = метр недоступен (нет env-пары / канал упал / записи нет) —
 * вызывающие деградируют честно, НЕ подмешивая счётчик приложения.
 * Кэш 30 с: /health опрашивается каждые 30 с — метр не чаще 2 чтений/мин.
 */
export async function getGatewayDayBudget(): Promise<GatewayDayBudget | null> {
  const cached = g[GLOBAL_KEY];
  if (cached && Date.now() - cached.at < MEM_TTL_MS) return cached.value;

  const gw = gatewayBase();
  if (!gw) {
    g[GLOBAL_KEY] = { value: null, at: Date.now() };
    return null;
  }
  try {
    const res = await fetch(`${gw.url}/kvstore/get`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": gw.secret },
      body: JSON.stringify({ key: `quota:day:${dayKeyUtc()}` }),
      signal: AbortSignal.timeout(KVSTORE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`kvstore/get HTTP ${res.status}`);
    const data = (await res.json()) as { value?: string | null };
    if (data.value == null) {
      // записей дня нет — сегодня чтений ещё не было (метр жив, бюджет 0)
      const value: GatewayDayBudget = {
        day: dayKeyUtc(), rowsRead: 0, rowsWritten: 0, quotaExhaustedAt: null, readPct: 0,
      };
      g[GLOBAL_KEY] = { value, at: Date.now() };
      return value;
    }
    const parsed = JSON.parse(data.value) as {
      rowsRead?: number; rowsWritten?: number; quotaExhaustedAt?: string | null;
    };
    const rowsRead = Number(parsed.rowsRead ?? 0);
    const rowsWritten = Number(parsed.rowsWritten ?? 0);
    const value: GatewayDayBudget = {
      day: dayKeyUtc(),
      rowsRead: Number.isFinite(rowsRead) ? rowsRead : 0,
      rowsWritten: Number.isFinite(rowsWritten) ? rowsWritten : 0,
      quotaExhaustedAt: parsed.quotaExhaustedAt ?? null,
      readPct: Math.round((rowsRead / D1_DAILY_READ_LIMIT) * 1000) / 10,
    };
    g[GLOBAL_KEY] = { value, at: Date.now() };
    return value;
  } catch (err) {
    logger.warn("getGatewayDayBudget failed (non-fatal, meter unavailable)", {
      error: err instanceof Error ? err.message : String(err),
    });
    g[GLOBAL_KEY] = { value: null, at: Date.now() };
    return null;
  }
}

/** Сброс кэша метра (тесты). */
export function resetGatewayDayBudgetForTests(): void {
  delete g[GLOBAL_KEY];
}
