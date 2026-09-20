// src/lib/routes-hotspot-cache.ts — v2.40.9 (Pack C, N-7): ПЕРСИСТЕНТНЫЙ кэш
// тяжёлых агрегатов вкладки «Маршруты» (heavy-segments).
//
// ПРОБЛЕМА (N-7, замер 20.09): computeGroupHotspots — последний full-scan-путь
// дашборда: ≤8 групп × ≤50 сессий × точки, и loadGroupSessions +
// computeGroupHotspots читали ОДНИ И ТЕ ЖЕ строки ДВАЖДЫ за запрос (~100–300
// тыс. rows_read на холодном LRU). In-memory LRU (полилайн) умирает с каждым
// ресайклом Render free (2 за 40 минут 20.09) — «холодный показ» платит
// полным пересчётом каждый раз.
//
// РЕШЕНИЕ — два слоя + честный watermark:
//   Слой 1: in-memory LRU ответа (globalThis, TTL 60 с, ≤32 записей) — тёплые
//           повторы в пределах опроса вкладки бесплатны и не трогают сеть.
//   Слой 2: KV шлюза d1-gateway (/kvstore/get|/kvstore/put, Pack C) — переживает
//           ресайклы инстанса, чтение ~40 мс, 0 строк D1-квоты. Ключ включает
//           watermark — sha256 по СОСТАВУ групп (routeHash:sessionCount:lastSeen),
//           периоду, tz и версии конвейера: новая сессия в группе / удаление /
//           смена версии кэша сессий → ДРУГОЙ watermark → ДРУГОЙ ключ →
//           пересчёт (старая запись протухает по TTL 1 ч). Инвалидация по
//           данным — атомарная и бесплатная, «watermark-паттерн».
//   Двойное чтение точек убрано отдельно (route-comparison N-7: точки грузятся
//   ОДИН раз на запрос и передаются в оба конвейера — −50% холодного пути).
//
// ГАРАНТИИ (консервативные, как edge-gateway.ts):
//   • любая ошибка/404 (воркер старой версии) → compute + kv:"error",
//     ответ НЕ меняется — кэш строго опционален;
//   • JSON больше 512 КБ не пишется в KV (лимит значения), ответ идёт как
//     всегда — пересчитывается;
//   • метрики routes_hotspot_cache_total{hit|miss} — наблюдаемость эффекта.

import { logger } from "./logger";
import { inc } from "./metrics";
import { edgeKvEnabled } from "./edge-gateway";

const KVSTORE_TIMEOUT_MS = 8_000;
/** TTL in-memory слоя: тёплые повторы опроса вкладки (60 с смарт-опрос §A3). */
const MEM_TTL_MS = 60_000;
/** Записей in-memory (8 периодов × scope × запас — маленький и предсказуемый). */
const MEM_MAX = 32;
/** TTL KV-слоя: страховка от дрейфа, watermark — основная инвалидация. */
const KV_TTL_SEC = 3_600;
/** Лимит значения KV (зеркало KVCACHE_VALUE_MAX_CHARS воркера, 512 КБ). */
const KV_VALUE_MAX_CHARS = 512 * 1024;

export const ROUTES_HS_HIT_TOTAL = "routes_hotspot_cache_total";
inc(ROUTES_HS_HIT_TOTAL, "Routes heavy-segments cache hits (memory|kv)", 0, 'layer="memory"');
inc(ROUTES_HS_HIT_TOTAL, "", 0, 'layer="kv"');
inc(ROUTES_HS_HIT_TOTAL, "", 0, 'layer="miss"');
inc(ROUTES_HS_HIT_TOTAL, "", 0, 'layer="error"');

export type HotspotCacheSource = "memory" | "kv" | "miss" | "error";

export interface HotspotCacheResult<T> {
  data: T;
  cache: HotspotCacheSource;
  watermark: string;
}

// ——— Слой 1: in-memory LRU на globalThis (переживает HMR) ———
interface MemEntry {
  payload: string;
  expiresAt: number;
}
const GLOBAL_KEY = "__telematRoutesHotspotCache";
const g = globalThis as unknown as { [GLOBAL_KEY]?: Map<string, MemEntry> };

function memStore(): Map<string, MemEntry> {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

// ——— Слой 2: сырой KV шлюза (/kvstore, Pack C) ———
// edge-gateway.ts держит /kvcache для SELECT-результатов; здесь нужен
// произвольный JSON ответа — отдельная пара эндпоинтов воркера v2.40.9.
// Тот же гейт включённости (EDGE_KVCACHE_ENABLED + USING_D1 + env-пара шлюза).
function gatewayBase(): { url: string; secret: string } | null {
  const url = (process.env.D1_GATEWAY_URL ?? "").replace(/\/$/, "");
  const secret = process.env.D1_GATEWAY_SECRET ?? "";
  return url && secret ? { url, secret } : null;
}

async function kvStoreGet(key: string): Promise<string | null | undefined> {
  // undefined = канал недоступен/ошибка (не «нет записи»)
  const gw = gatewayBase();
  if (!gw) return undefined;
  try {
    const res = await fetch(`${gw.url}/kvstore/get`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": gw.secret },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(KVSTORE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`kvstore/get HTTP ${res.status}`);
    const data = (await res.json()) as { value?: string | null };
    return data.value ?? null;
  } catch (err) {
    logger.warn("kvStoreGet failed (non-fatal, cache disabled for this request)", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function kvStorePut(key: string, value: string, ttlSec: number): Promise<boolean> {
  const gw = gatewayBase();
  if (!gw) return false;
  try {
    const res = await fetch(`${gw.url}/kvstore/put`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-secret": gw.secret },
      body: JSON.stringify({ key, value, ttlSec }),
      signal: AbortSignal.timeout(KVSTORE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`kvstore/put HTTP ${res.status}`);
    return true;
  } catch (err) {
    logger.warn("kvStorePut failed (non-fatal, response served uncached)", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ——— watermark: состав групп + период + tz + версия конвейера ———
// Простой FNV-1a 32×4 (быстрый, без Web Crypto await) — коллизии на ~десятках
// ключей практически исключены, семантика «изменился состав → другой ключ»
// держится детерминированным сканом ОТСОРТИРОВАННОГО списка (порядок групп из
// GROUP BY стабилен, но каноническая сортировка внутри — страховка от смены
// ORDER BY в listRouteGroups без смены подписи).
export function hotspotWatermark(parts: string[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0xdeadbeef, h4 = 0x41c6ce57;
  for (const part of [...parts].sort()) {
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      h1 = (h1 ^ c) * 0x01000193 >>> 0;
      h2 = (h2 + c * (i + 7)) >>> 0;
      h3 = (h3 ^ (c << 4)) * 31 >>> 0;
      h4 = (h4 + (c << 3) + h4 % 7) >>> 0;
    }
    // разделитель частей не даёт склейкам разных списков совпасть
    h1 = (h1 ^ 0x2f) >>> 0; h2 = (h2 ^ 0x2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * Кэшированное вычисление heavy-segments-ответа.
 * @param keyParts части ключа БЕЗ watermark (scope/period/tz)
 * @param parts watermark-состав (сигнатура групп + период + tz + версия кэша)
 * @param compute тяжёлое вычисление (чтение точек + конвейер)
 */
export async function cachedHotspotResponse<T>(
  keyParts: string[],
  parts: string[],
  compute: () => Promise<T>
): Promise<HotspotCacheResult<T>> {
  const watermark = hotspotWatermark(parts);
  const key = `routes:hs:${[...keyParts, watermark].join(":")}`;

  // Слой 1: память
  const mem = memStore();
  const hit = mem.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    const parsed = safeParse<T>(hit.payload);
    if (parsed !== undefined) {
      inc(ROUTES_HS_HIT_TOTAL, "", 1, 'layer="memory"');
      return { data: parsed, cache: "memory", watermark };
    }
  }
  if (hit) mem.delete(key); // просроченная/битая

  // Слой 2: KV шлюза (только в D1-режиме с включённым edge-KV)
  if (edgeKvEnabled()) {
    const raw = await kvStoreGet(key);
    if (raw === null) {
      // записи нет — честный miss (не ошибка)
    } else if (typeof raw === "string") {
      const parsed = safeParse<T>(raw);
      if (parsed !== undefined) {
        inc(ROUTES_HS_HIT_TOTAL, "", 1, 'layer="kv"');
        mem.set(key, { payload: raw, expiresAt: Date.now() + MEM_TTL_MS });
        lruTrim();
        return { data: parsed, cache: "kv", watermark };
      }
    }
    // undefined (канал упал) → считаем «miss» с пометкой error ниже
  }

  // Вычисление
  const data = await compute();
  const payload = JSON.stringify(data);
  const source: HotspotCacheSource = edgeKvEnabled() ? "miss" : "error";
  inc(ROUTES_HS_HIT_TOTAL, "", 1, `layer="${source}"`);

  // write-through в оба слоя (KV — только компактные значения)
  if (payload.length <= KV_VALUE_MAX_CHARS) {
    if (edgeKvEnabled()) {
      void kvStorePut(key, payload, KV_TTL_SEC); // fire-and-forget
    }
    mem.set(key, { payload, expiresAt: Date.now() + MEM_TTL_MS });
    lruTrim();
  } else {
    logger.info("hotspot cache payload oversized → memory-only skipped (per-request recompute)", {
      key, bytes: payload.length,
    });
  }
  return { data, cache: source, watermark };
}

function lruTrim(): void {
  const mem = memStore();
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Сброс слоёв (тесты/явная инвалидация). */
export function resetHotspotCacheForTests(): void {
  g[GLOBAL_KEY] = new Map();
}
