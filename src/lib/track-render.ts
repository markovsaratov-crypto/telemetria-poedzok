// src/lib/track-render.ts — v2.41.0 (P0-C, N-9 «bloat батч-ответов»):
// СЕРВЕРНОЕ прореживание payload'ов для РЕНДЕР-режима батч-роутов.
//
// ПРОБЛЕМА (замер Task 28, 21.09): первое открытие пользовательского среза —
// 10,27 с / 10,3 МБ (track/batch 6,37 МБ + events/batch 3,50 МБ + stats
// 0,45 МБ) на 0.1 CPU Render free, при том что клиент РЕНДЕРИТ ≤4000 точек
// на карту (map-track MAX_RENDER_TRACK_POINTS) и ≤20 000 в агрегат —
// ~99% переданных байтов выбрасывается. Сериализация+gzip 6,37 МБ — 3,11 с
// САМИ ПО СЕБЕ, TTL 60 с истекает быстрее, чем пользователь возвращается
// на вкладку.
//
// РЕШЕНИЕ — ?mode=render: сервер отдаёт УЖЕ прореженный payload. Функции
// здесь чистые и ДЕТЕРМИНДИРОВАННЫЕ (одинаковый вход → одинаковый выход),
// поэтому применяются к ОДНОМУ И ТОМУ ЖЕ payload'у что из персистентного
// кэша, что из live-конвейера — render-ответ не зависит от пути данных.
// Кэш сессий (trackCache/eventsCache) хранит ПОЛНЫЕ payload'ы: KPI и
// скоростной профиль рендерятся из полных данных, прореживание — свойство
// ОТВЕТА, а не кэша (анти-паттерн «кэш рендера рядом с кэшем истины»).
//
// Транформация трека (thinTrackForRender):
//   • points — равномерный сэмпл ≤ maxPoints (downsampleUniform: первая и
//     последняя точки сохраняются — старт/финиш маркеров);
//   • ПОЛЯ ТОЧЕК: {i, t, lat, lng, v, st} — alt/brg/acc ВЫБРАСЫВАЮТСЯ
//     (карта их не читает; ~40% байтов точки);
//   • i — ПЕРЕНУМЕРОВАН в индексы прореженного массива (оригинальный индекс
//     нужен только для перемапинга разрывов внутри функции);
//   • segments — пересобираются ПОСЛЕ сэмпла по той же таблице SPEED_BUCKETS
//     (цвет по v м/с → км/ч): границы групп сместятся к ближайшим
//     оставшимся точкам, полилинии — те же цвета;
//   • gaps — ИНДЕКСЫ ИСХОДНОГО массива перемапятся на ближайшие оставшиеся
//     позиции (бинарный поиск — тот же приём, что aggregateTrack v2.38.1);
//     «пересчитывать разрывы по dt оставшихся» НЕЛЬЗЯ — сэмпл 56К→400
//     делает dt≈140 с и превратил бы весь трек в «разрыв»;
//   • harshPoints — потолок maxHarsh «самых резких» по |dv| (стабильный
//     порядок) — зеркально MAX_PERIOD_HARSH_POINTS aggregateTrack;
//   • bounds/markers/legend — сохраняются ИСХОДНЫЕ (bounds от полного
//     отфильтрованного трека: авто-зум карты не должен дышать при сэмпле;
//     start/finish = первая/последняя точки, которые сэмпл сохраняет).
//
// Транформация событий (thinEventsForRender): maneuvers ≤400, gg.points
// ≤600 (равномерно), harshEvents/hscEvents ≤300 (равномерно) — summary
// СОХРАНЯЕТ ПОЛНЫЕ СЧЁТЧИКИ (честность цифр блока «События вождения» —
// прорежены точки-маркеры, не метрики).

import { downsampleUniform } from "./downsample";
import { SPEED_BUCKETS } from "./session-track";

/** Дефолты рендер-режима (P0-C): потолок точек и «самых резких» на запись. */
export const RENDER_MAX_POINTS_DEFAULT = 400;
export const RENDER_MAX_HARSH_DEFAULT = 300;
/** Рендер-прореживание событий (на запись): G-G/манёвры/события. */
export const RENDER_EVENTS_CAPS = {
  maneuvers: 400,
  ggPoints: 600,
  harshEvents: 300,
  hscEvents: 300,
} as const;

interface RenderTrackPoint {
  i: number;
  t: number;
  lat: number;
  lng: number;
  v: number | null;
  alt?: number | null;
  brg?: number | null;
  acc?: number | null;
  st: 0 | 1;
}

interface RenderTrackPayload {
  sessionId: string;
  cacheV?: number;
  deviceId?: string;
  startTime?: string;
  endTime?: string | null;
  pointCount?: number | null;
  bounds?: unknown;
  points?: RenderTrackPoint[];
  segments?: Array<{ color: string; bucket: string; points: Array<{ lat: number; lng: number }>; startIndex: number; endIndex: number }>;
  gaps?: Array<{ fromIdx: number; toIdx: number; durationSec: number }>;
  harshPoints?: Array<{ lat: number; lng: number; type: string; dv: number; idx: number; t: number }>;
  markers?: unknown;
  defaultLayer?: unknown;
  availableLayers?: unknown;
  legend?: unknown;
  [key: string]: unknown;
}

function colorForSpeedKmh(kmh: number | null): string {
  if (kmh === null) return SPEED_BUCKETS[0].color;
  for (const b of SPEED_BUCKETS) if (kmh <= b.max) return b.color;
  return SPEED_BUCKETS[SPEED_BUCKETS.length - 1].color;
}

/**
 * Прореженный трек для рендера. Чистая функция: одинаковый payload →
 * одинаковый результат (путь «из кэша» ≡ путь «live-конвейер»).
 */
export function thinTrackForRender(
  payload: Record<string, unknown>,
  maxPoints = RENDER_MAX_POINTS_DEFAULT,
  maxHarsh = RENDER_MAX_HARSH_DEFAULT
): Record<string, unknown> {
  const p = payload as RenderTrackPayload;
  const source = Array.isArray(p.points) ? p.points : [];
  if (source.length === 0) {
    // пустой трек — форма сохраняется, рендер-метка для наблюдаемости
    return { ...p, render: { maxPoints, sourcePoints: 0 } };
  }

  // ——— равномерный сэмпл + компактные поля ———
  const kept = downsampleUniform(source, Math.max(2, maxPoints));
  const thinned: Array<{ i: number; t: number; lat: number; lng: number; v: number | null; st: 0 | 1 }> = kept.map((pt, pos) => ({
    i: pos, // перенумерация: индексы ссылок (segments/gaps) — на прореженный массив
    t: pt.t,
    lat: pt.lat,
    lng: pt.lng,
    v: pt.v,
    st: pt.st,
  }));

  // ——— сегменты: пересборка по цвету СКОРОСТИ оставшихся точек ———
  const segments: NonNullable<RenderTrackPayload["segments"]> = [];
  if (thinned.length > 0) {
    let currentColor = colorForSpeedKmh(thinned[0].v != null ? thinned[0].v * 3.6 : null);
    let currentBucket = SPEED_BUCKETS.find((b) => b.color === currentColor)?.label ?? "?";
    let currentPoints: Array<{ lat: number; lng: number }> = [{ lat: thinned[0].lat, lng: thinned[0].lng }];
    let startIndex = 0;
    for (let i = 1; i < thinned.length; i++) {
      const v = thinned[i]?.v;
      const c = colorForSpeedKmh(v != null ? v * 3.6 : null);
      if (c === currentColor) {
        currentPoints.push({ lat: thinned[i].lat, lng: thinned[i].lng });
      } else {
        segments.push({ color: currentColor, bucket: currentBucket, points: currentPoints, startIndex, endIndex: i - 1 });
        currentColor = c;
        currentBucket = SPEED_BUCKETS.find((b) => b.color === c)?.label ?? "?";
        currentPoints = [{ lat: thinned[i].lat, lng: thinned[i].lng }];
        startIndex = i;
      }
    }
    segments.push({ color: currentColor, bucket: currentBucket, points: currentPoints, startIndex, endIndex: thinned.length - 1 });
  }

  // ——— разрывы: исходные ИНДЕКСЫ (оригинальный i) → ближайшие оставшиеся позиции ———
  const gaps: NonNullable<RenderTrackPayload["gaps"]> = [];
  const srcGaps = Array.isArray(p.gaps) ? p.gaps : [];
  if (srcGaps.length > 0 && kept.length === source.length) {
    // сэмпл не прореживал — индексы уже в этом массиве
    for (const g of srcGaps) gaps.push({ fromIdx: g.fromIdx, toIdx: g.toIdx, durationSec: g.durationSec });
  } else if (srcGaps.length > 0) {
    // Бинарный поиск позиции в kept, ближайшей к ИСХОДНОМУ индексу разрыва.
    // kept[pos].i — оригинальный индекс точки (до перенумерации).
    const origIdx = kept.map((pt) => pt.i);
    const nearestKeptPos = (idx: number): number => {
      let lo = 0;
      let hi = origIdx.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (origIdx[mid] < idx) lo = mid + 1;
        else hi = mid;
      }
      const up = origIdx[lo];
      const down = origIdx[Math.max(0, lo - 1)];
      return Math.abs(up - idx) <= Math.abs(down - idx) ? lo : Math.max(0, lo - 1);
    };
    const seenFrom = new Set<number>();
    for (const g of srcGaps) {
      const fromIdx = nearestKeptPos(g.fromIdx);
      if (seenFrom.has(fromIdx)) continue; // уникальный fromIdx = уникальный React-ключ
      seenFrom.add(fromIdx);
      gaps.push({ fromIdx, toIdx: Math.max(fromIdx + 1, nearestKeptPos(g.toIdx)), durationSec: g.durationSec });
    }
  }

  // ——— «самые резкие» ≤ maxHarsh по |dv| (стабильный порядок по исходнику) ———
  const srcHarsh = Array.isArray(p.harshPoints) ? p.harshPoints : [];
  let harsh = srcHarsh;
  if (srcHarsh.length > maxHarsh) {
    harsh = srcHarsh
      .map((h, i) => ({ h, i }))
      .sort((a, b) => Math.abs(b.h.dv) - Math.abs(a.h.dv))
      .slice(0, maxHarsh)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.h);
  }

  return {
    ...p,
    points: thinned,
    segments,
    gaps,
    harshPoints: harsh,
    // bounds/markers/legend/defaultLayer/availableLayers — исходные (см. шапку)
    // рендер-метка для наблюдаемости и QA (аддитивное поле)
    render: { maxPoints, sourcePoints: source.length },
  };
}

interface RenderEventsPayload {
  sessionId: string;
  cacheV?: number;
  deviceId?: string;
  maneuvers?: unknown[];
  gg?: { points?: unknown[]; rings?: number[] };
  harshEvents?: unknown[];
  hscEvents?: unknown[];
  summary?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Прореженные события для рендера. Summary — БЕЗ изменений: счётчики честные,
 * прорежены только массивы маркеров/точек диаграммы.
 */
export function thinEventsForRender(payload: Record<string, unknown>): Record<string, unknown> {
  const p = payload as RenderEventsPayload;
  const maneuvers = Array.isArray(p.maneuvers) ? downsampleUniform(p.maneuvers, RENDER_EVENTS_CAPS.maneuvers) : p.maneuvers ?? [];
  const ggPoints = Array.isArray(p.gg?.points) ? downsampleUniform(p.gg.points, RENDER_EVENTS_CAPS.ggPoints) : p.gg?.points ?? [];
  const harshEvents = Array.isArray(p.harshEvents) ? downsampleUniform(p.harshEvents, RENDER_EVENTS_CAPS.harshEvents) : p.harshEvents ?? [];
  const hscEvents = Array.isArray(p.hscEvents) ? downsampleUniform(p.hscEvents, RENDER_EVENTS_CAPS.hscEvents) : p.hscEvents ?? [];
  return {
    ...p,
    maneuvers,
    gg: { ...(p.gg ?? {}), points: ggPoints },
    harshEvents,
    hscEvents,
    render: {
      sourceManeuvers: Array.isArray(p.maneuvers) ? p.maneuvers.length : 0,
    },
  };
}

/** Разбор ?mode= + ?maxPoints= для батч-роутов (валидация с клампом). */
export function parseRenderMode(
  mode: string | null,
  maxPointsRaw: string | null
): { render: boolean; maxPoints: number } {
  const render = mode === "render";
  let maxPoints = RENDER_MAX_POINTS_DEFAULT;
  if (render && maxPointsRaw != null) {
    const n = Number(maxPointsRaw);
    // кламп: минимум 50 (меньше — сэмпл вырождается), максимум 2000
    if (Number.isFinite(n) && n >= 1) {
      maxPoints = Math.min(2000, Math.max(50, Math.round(n)));
    }
  }
  return { render, maxPoints };
}
