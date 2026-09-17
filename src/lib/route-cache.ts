// src/lib/route-cache.ts — v2.38.2 (ревью F64): in-memory кэш результатов
// маршрутизации (методология §13.4/§14, ADMIN_SPEC §12.5, TECHNICAL §10.2).
//
// ПРОБЛЕМА (F64): кэш маршрутизации описан в трёх доках, но в коде отсутствовал —
// каждый вызов routeRequest (src/lib/routing/chain.ts) ходил живым запросом в
// 2ГИС/OSRM. Ежедневные одинаковые поездки (дом→работа, ~1 джоб на запись, мульти-
// leg поездки — по джобу на leg) били квоту 2ГИС каждый раз заново. Таблица
// RouteCache жила в схеме/бэкапах/restore как зомби (db-обёртка удалена в v2.18.0
// вместе с мёртвым src/lib/cache.ts).
//
// РЕАЛИЗАЦИЯ (по фикс-рецепту ревью): ОДНОУРОВНЕВЫЙ in-memory LRU:
//   • ключ — grid-snapped координаты старта/финиша + time-of-day бакет:
//     snap-to-grid с шагом ROUTE_ID_SNAP_GRID_DEG (0.0005° ≈ 55 м — та же сетка,
//     что и routeHash §10.0, см. src/lib/route-hash.ts; математика снапа
//     идентична — Math.round(coord/step)*step), ToD-бакет 0/3/…/21 по МЕСТНОМУ
//     времени (TELEMAT_TIMEZONE — пробки 2ГИС привязаны к гражданским часам
//     «утренний пик», а не к UTC-часам сервера);
//   • TTL 24 ч (ROUTE_CACHE_TTL_HOURS): суточная периодичность поездок при
//     приемлемой свежести пробок; истёкшая запись удаляется лениво при обращении;
//   • LRU ≤ 512 записей (Map с переустановкой ключа — тот же приём, что
//     polylineCache в route-comparison.ts): 512 маршрутов × полилайн/сегменты —
//     единицы десятков МБ, верхняя граница памяти гарантирована;
//   • кэшируются только УСПЕШНЫЕ ответы 2ГИС/OSRM; гаверсинус-фоллбек
//     детерминирован и бесплатен — кэшировать нечего (иначе фолббек «прилипал»
//     бы на 24 ч при восстановлении провайдера);
//   • реестр на globalThis: instrumentation-воркер и роуты Next.js могут
//     получать разные экземпляры модуля (паттерн metrics.ts P1-10).
//
// Кэш сознательно без персиста в SQLite-таблицу RouteCache: ранние редакции доков
// описывали двухуровневую схему (L2 в БД), но in-memory покрывает сценарий
// «суточные повторы» в одном процессе (воркер маршрутизирует все джобы), а
// персист в D1 добавлял бы чтение/запись на каждый промах без выигрыша.
// Таблица остаётся в схеме/бэкапах/restore для совместимости дампов — см.
// комментарий у db.routeCache-заглушки в src/lib/db.ts.
//
// ЗАВИСИМОСТИ: только env — модуль edge-safe (chain.ts собирается и в Edge-вариант
// instrumentation → worker-runtime, Node-only импорты запрещены, см. route-hash.ts).

import { env } from "./env";
import type { RouteResult } from "./routing/chain";

// ——— Местное время (TELEMAT_TIMEZONE): ToD-бакет кэша §13.4 и бакеты §10.3/§10.4 ———
// v2.38.2 (ревью F68): этот же хелпер используют routeTrafficPattern /
// routeDayOfWeekPattern (src/lib/route-comparison.ts) — прежде их бакеты
// считались по СЕРВЕРНОМУ поясу (UTC на Render: пики «сдвигались» на 3–4 ч),
// хотя методология определяет их по гражданским часам («утренний пик 6–9»).
// Форматтер создаётся один раз на пояс (Intl-конструирование дорого);
// невалидное IANA-имя → фолбэк на серверный пояс (lenient, без падения).

const DOW_SHORT_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

let tzFormatter: Intl.DateTimeFormat | null = null;
let tzFormatterZone: string | null = null;

function formatter(): Intl.DateTimeFormat {
  const zone = env().TELEMAT_TIMEZONE;
  if (tzFormatter == null || tzFormatterZone !== zone) {
    try {
      tzFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hourCycle: "h23",
        weekday: "short",
      });
    } catch {
      // невалидный TELEMAT_TIMEZONE — серверный пояс (не роняем маршрутизацию)
      tzFormatter = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        weekday: "short",
      });
    }
    tzFormatterZone = zone;
  }
  return tzFormatter;
}

/** Местный час (0–23) инстанта tsMs в TELEMAT_TIMEZONE. */
export function localHour(tsMs: number): number {
  for (const part of formatter().formatToParts(tsMs)) {
    if (part.type === "hour") {
      const h = Number(part.value);
      // hourCycle h23 в редких окружениях даёт "24" на полночь — нормализуем
      return Number.isFinite(h) ? h % 24 : 0;
    }
  }
  return 0;
}

/** Местный день недели (0=пн … 6=вс) инстанта tsMs в TELEMAT_TIMEZONE. */
export function localDow(tsMs: number): number {
  for (const part of formatter().formatToParts(tsMs)) {
    if (part.type === "weekday") {
      return DOW_SHORT_INDEX[part.value] ?? 0;
    }
  }
  return 0;
}

// ——— Кэш §13.4/§14 ———

const ROUTE_CACHE_MAX_ENTRIES = 512; // LRU-ёмкость (см. шапку)

interface RouteCacheEntry {
  result: RouteResult;
  ts: number; // мс epoch записи
}

const GLOBAL_KEY = "__telemetriaRouteCache";
const g = globalThis as unknown as { [GLOBAL_KEY]?: Map<string, RouteCacheEntry> };

function store(): Map<string, RouteCacheEntry> {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY];
}

function ttlMs(): number {
  return env().ROUTE_CACHE_TTL_HOURS * 3_600_000;
}

// snap-to-grid — идентичен §10.0 из src/lib/route-hash.ts (не экспортирован там;
// пере-используем формулу read-only, шаг тот же ROUTE_ID_SNAP_GRID_DEG)
function snapToGrid(lat: number, lon: number, step: number): { lat: number; lon: number } {
  return {
    lat: Math.round(lat / step) * step,
    lon: Math.round(lon / step) * step,
  };
}

/**
 * Ключ кэша: grid-snapped старт/финиш + ToD-бакет (§13.4).
 * Две поездки в одной ячейке сетки (~55 м) в одном 3-часовом бакете —
 * один и тот же ключ (одинаковый маршрут в сопоставимых пробках).
 * toFixed(4) — разрешение сетки 0.0005°, артефакты float-округления гасятся.
 */
export function routeCacheKey(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
  departAtMs?: number
): string {
  const step = env().ROUTE_ID_SNAP_GRID_DEG;
  const s = snapToGrid(startLat, startLon, step);
  const e = snapToGrid(endLat, endLon, step);
  // бакет по моменту старта (utc-параметр 2ГИС): нет departAt — «сейчас»
  const ts = departAtMs != null && Number.isFinite(departAtMs) && departAtMs > 0 ? departAtMs : Date.now();
  const todBucket = Math.floor(localHour(ts) / 3); // 0..7 (§13.4: 0,3,…,21)
  return `${s.lat.toFixed(4)},${s.lon.toFixed(4)}:${e.lat.toFixed(4)},${e.lon.toFixed(4)}:${todBucket}`;
}

/**
 * Попадание в кэш (§14: «check L1 → запрос к провайдеру»).
 * Возвращает копию результата с cached=true (полилиния/сегменты — разделяемые
 * массивы: контракт — получатель читает, не мутирует; воркер удовлетворяет).
 */
export function routeCacheGet(key: string): RouteResult | null {
  const map = store();
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts >= ttlMs()) {
    map.delete(key); // ленивая инвалидация по TTL
    return null;
  }
  // LRU: переустановка ключа в «свежий» хвост Map (порядок вставки)
  map.delete(key);
  map.set(key, hit);
  return { ...hit.result, cached: true };
}

/**
 * Запись в кэш после УСПЕШНОГО ответа провайдера (гаверсинус-фоллбек не
 * кэшируется — см. шапку). Вытеснение старейшего при переполнении.
 */
export function routeCachePut(key: string, result: RouteResult): void {
  const map = store();
  map.delete(key);
  map.set(key, { result, ts: Date.now() });
  while (map.size > ROUTE_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
