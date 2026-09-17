// src/lib/route-hash.ts — v2.38.1 (ревью F7): §10.0 routeHash + topologyHash
// для ПРОД-конвейера (in-process воркер + backfill-скрипт).
//
// ПРОБЛЕМА (F7): единственная реализация computeRouteHash жила в
// НЕ-деплоемом mini-services/worker/processor.ts и попадала в БД только
// через внешний протокол /api/worker/complete. Прод-воркер (worker-runtime.ts,
// instrumentation.ts) маршруты маршрутизировал, но routeHash не считал →
// Session.routeHash оставался NULL для всех новых сессий → группа метрик
// §10.0–§10.6 (RouteAvg/Best/Worst/StdDev, TrafficPattern, DayOfWeek,
// RouteTrend, HotspotSegments, routeId-группировка) тихо возвращала пустоту.
//
// РЕШЕНИЕ: порт алгоритма из mini-services/worker/processor.ts:775-810
// (computeRouteHash + snapToGrid + sha256). Математика ДОСЛОВНО идентична
// (значения routeHash/topologyHash стабильны относительно мини-сервиса —
// сравнение маршрутов в route-comparison группирует одинаково):
//   • snap-to-grid по ROUTE_ID_SNAP_GRID_DEG (дефолт 0.0005° ≈ 55 м);
//   • keypoints = старт/финиш активной части + поворотные точки сегментов
//     (Δ курс > 60°), каждая — «lat.toFixed(4),lon.toFixed(4)» после снапа;
//   • topologyHash = sha256(keypoints.join("|")).slice(0, 8);
//   • routeHash = sha256("start:end:topologyHash").slice(0, 16);
//   • без активной поездки → оба NULL; без сегментов → topologyHash
//     literal "no_segments" (маршрут «точка-в-точку», только A→B).
//
// ЗАВИСИМОСТИ: только env (шаг сетки) и Web Crypto (crypto.subtle.digest —
// SHA-256 тот же дайджест, что Node createHash, но edge-safe: Turbopack
// собирает Edge-вариант instrumentation.ts → worker-runtime → этот файл,
// Node-импорт "crypto" здесь запрещён, см. src/instrumentation.ts).

import { env } from "./env";

/** Точка активной части записи (§4.11) — старт/финиш для снапа. */
export interface RouteHashCoord {
  lat: number;
  lon: number;
}

/** Сегмент плана маршрута: достаточно lat/lon; bearing опционален
 *  (провайдеры прод-цепочки 2ГИС/OSRM его не заполняют — как и в мини-сервисе,
 *  поворотные keypoints тогда не добавляются, хэш остаётся стабильным). */
export interface RouteHashSegment {
  lat: number;
  lon: number;
  bearing?: number | null;
}

/** Результат: значения пишутся в Session.routeHash / Session.topologyHash. */
export interface RouteHashResult {
  routeHash: string | null;
  topologyHash: string | null;
}

// ——— snap-to-grid (§10.0): округление координаты к центру ячейки ———
function snapToGrid(coord: RouteHashCoord, step: number): RouteHashCoord {
  return {
    lat: Math.round(coord.lat / step) * step,
    lon: Math.round(coord.lon / step) * step,
  };
}

// ——— SHA-256 (hex) через Web Crypto: edge-safe, дайджест идентичен
// Node createHash("sha256") из мини-сервиса → значения хэшей совпадают ———
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * §10.0: детерминированный routeHash маршрута.
 * Портирован дословно из mini-services/worker/processor.ts (computeRouteHash).
 * @param activeStartCoord старт активной части записи (null → без активной
 *        поездки, оба хэша NULL — parity с мини-сервисом);
 * @param activeEndCoord финиш активной части;
 * @param segments сегменты плана маршрута из RouteResult (может быть пуст —
 *        haversine-фоллбек/джоб без маршрута → topologyHash "no_segments").
 */
export async function computeRouteHash(
  activeStartCoord: RouteHashCoord | null,
  activeEndCoord: RouteHashCoord | null,
  segments: RouteHashSegment[]
): Promise<RouteHashResult> {
  if (!activeStartCoord || !activeEndCoord) {
    return { routeHash: null, topologyHash: null };
  }
  const GRID_STEP = env().ROUTE_ID_SNAP_GRID_DEG; // дефолт 0.0005° (как в мини-сервисе)
  const startGrid = snapToGrid(activeStartCoord, GRID_STEP);
  const endGrid = snapToGrid(activeEndCoord, GRID_STEP);
  const keypoints: string[] = [`${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}`];

  if (segments.length === 0) {
    keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);
    const topologyHash = "no_segments";
    const routeSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:${topologyHash}`;
    return { routeHash: (await sha256Hex(routeSource)).slice(0, 16), topologyHash };
  }

  // Поворотные точки: Δ курса соседних сегментов > 60° (сегменты без bearing
  // пропускаются — как в мини-сервисе, где провайдеры его не заполняли).
  for (let i = 1; i < segments.length; i++) {
    const b0 = segments[i - 1].bearing;
    const b1 = segments[i].bearing;
    if (b0 != null && b1 != null) {
      const raw = Math.abs(b1 - b0);
      if (Math.min(raw, 360 - raw) > 60) {
        const grid = snapToGrid({ lat: segments[i].lat, lon: segments[i].lon }, GRID_STEP);
        keypoints.push(`${grid.lat.toFixed(4)},${grid.lon.toFixed(4)}`);
      }
    }
  }
  keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);
  const topologyHash = (await sha256Hex(keypoints.join("|"))).slice(0, 8);
  const routeSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:${topologyHash}`;
  return { routeHash: (await sha256Hex(routeSource)).slice(0, 16), topologyHash };
}
