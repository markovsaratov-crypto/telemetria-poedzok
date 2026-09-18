// src/lib/edge-gateway.ts — v2.39.0 (§B2, docs/OPTIMIZATION-PROPOSAL.md Вариант B):
// HTTP-интерфейс KV-кэша тяжёлых SELECT на d1-gateway-воркере.
//
// Контракт (воркер добавит эндпоинты; ДО его обновления /kvcache отвечает 404 —
// это задокументированное состояние, клиент ниже тихо фолбэчится):
//   POST {D1_GATEWAY_URL}/kvcache            body {key, sql, params, ttlSec}
//     → 200 {rows: [...], meta: {...}, kv: "hit" | "miss" | "passthrough"}
//   POST {D1_GATEWAY_URL}/kvcache/invalidate body {prefix}
//     → 200 {invalidated: N}
// Авторизация — существующий X-Gateway-Secret (D1_GATEWAY_SECRET).
//
// Гарантии клиента (консервативные, как §A1):
//   • работает ТОЛЬКО с SELECT (гейтвей сам валидирует; здесь — дублирующий
//     префикс-гард: не-SELECT никогда не уходит в /kvcache, идёт напрямую);
//   • работает только при USING_D1 (Turso/файл-путь — kv:"passthrough");
//   • ЛЮБАЯ ошибка/таймаут (AbortSignal.timeout 8с) → прямой libsql.execute
//     с пометкой kv:"error" — дашборд не меняет поведение;
//   • счётчики hit/miss/error экспонируются в /api/metrics (как D1_ROWS_READ_*).
//
// Ключи — соглашение §B2: dash:{scope}:{day}:{cacheVersion}; инвалидация —
// префиксом edgeKvInvalidate("dash:") при финализации сессии.

import { env } from "./env";
import { libsql, USING_D1 } from "./db";
import { inc } from "./metrics";
import { logger } from "./logger";

const KVCACHE_TIMEOUT_MS = 8_000;

// Метрики инициализируются при загрузке модуля (паттерн metrics.ts: имена
// появляются в /api/metrics даже с нулевыми значениями).
export const EDGE_KV_HIT_TOTAL = "edge_kv_hit_total";
export const EDGE_KV_MISS_TOTAL = "edge_kv_miss_total";
export const EDGE_KV_ERROR_TOTAL = "edge_kv_error_total";
inc(EDGE_KV_HIT_TOTAL, "Edge gateway KV cache hits", 0);
inc(EDGE_KV_MISS_TOTAL, "Edge gateway KV cache misses (populated)", 0);
inc(EDGE_KV_ERROR_TOTAL, "Edge gateway KV errors (fallback to direct D1)", 0);

/** Включён ли edge-KV: флаг И фактический D1-гейтвей в окружении. */
export function edgeKvEnabled(): boolean {
  return env().EDGE_KVCACHE_ENABLED === "true" && USING_D1;
}

export type EdgeKvStatus = "hit" | "miss" | "passthrough" | "error";

export interface EdgeKvRows {
  rows: Record<string, unknown>[];
  kv: EdgeKvStatus;
}

function isSelect(sql: string): boolean {
  // многострочный/комментированный SQL — гард по первому глаголу после trim
  return /^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*select\b/i.test(sql);
}

async function directExecute(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await libsql.execute({ sql, args: params as never[] });
  return res.rows as Record<string, unknown>[];
}

/**
 * SELECT через KV-кэш гейтвея (cache-aside на стороне воркера). Ошибки НЕ
 * бросаются наружу: любой сбой — прямой libsql.execute с kv:"error".
 */
export async function edgeKvQuery(
  key: string,
  sql: string,
  params: unknown[],
  ttlSec = 30
): Promise<EdgeKvRows> {
  if (!edgeKvEnabled() || !isSelect(sql)) {
    return { rows: await directExecute(sql, params), kv: "passthrough" };
  }
  const url = (process.env.D1_GATEWAY_URL ?? "").replace(/\/$/, "");
  const secret = process.env.D1_GATEWAY_SECRET ?? "";
  if (!url || !secret) {
    return { rows: await directExecute(sql, params), kv: "passthrough" };
  }
  try {
    const res = await fetch(`${url}/kvcache`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": secret },
      body: JSON.stringify({ key, sql, params, ttlSec }),
      signal: AbortSignal.timeout(KVCACHE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 до обновления воркера / 5xx — ожидаемая деградация, без стектрейса
      throw new Error(`kvcache HTTP ${res.status}`);
    }
    const data = (await res.json()) as { rows?: Record<string, unknown>[]; kv?: string };
    const kv = data.kv === "hit" ? "hit" : "miss";
    inc(kv === "hit" ? EDGE_KV_HIT_TOTAL : EDGE_KV_MISS_TOTAL, "", 1);
    return { rows: Array.isArray(data.rows) ? data.rows : [], kv };
  } catch (err) {
    inc(EDGE_KV_ERROR_TOTAL, "", 1);
    logger.warn("edgeKvQuery failed → direct D1 (kv:\"error\", §B2)", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return { rows: await directExecute(sql, params), kv: "error" };
    } catch (directErr) {
      // прямой путь тоже упал (квота D1/сеть) — исключение наружу, как вел
      // прежний код db.gpsPoint.count: вызывающий обработает своим catch
      logger.warn("edgeKvQuery direct fallback failed too", {
        key,
        error: directErr instanceof Error ? directErr.message : String(directErr),
      });
      throw directErr;
    }
  }
}

/**
 * Инвалидация KV по префиксу — fire-and-forget (не ждём ответа; ошибки глотаем:
 * устаревшая KV-запись живёт ≤ ttlSec 30с — сама протухнет).
 */
export function edgeKvInvalidate(prefix: string): void {
  if (!edgeKvEnabled()) return;
  const url = (process.env.D1_GATEWAY_URL ?? "").replace(/\/$/, "");
  const secret = process.env.D1_GATEWAY_SECRET ?? "";
  if (!url || !secret) return;
  void fetch(`${url}/kvcache/invalidate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-secret": secret },
    body: JSON.stringify({ prefix }),
    signal: AbortSignal.timeout(KVCACHE_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`kvcache/invalidate HTTP ${res.status}`);
    })
    .catch((err) => {
      logger.warn("edgeKvInvalidate failed (non-fatal, TTL истечёт сам)", {
        prefix,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
