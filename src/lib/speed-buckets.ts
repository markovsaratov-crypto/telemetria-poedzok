// src/lib/speed-buckets.ts — Единая шкала бакетов скорости для карты и графика.
//
// v2.9.10 (P0-фикс Render build failure — extract from map-track.tsx):
// Ранее SPEED_BUCKETS, speedBucketFor, ColoredTrack, SpeedBucket жили в
// src/components/map-track.tsx. Этот файл импортирует `leaflet` на top-level:
//   import L from "leaflet";
// При статической генерации страниц (prerender) Turbopack оценивает модуль
// map-track.tsx, что вызывает leaflet-инициализацию — а leaflet требует
// `window`, которого нет при SSR → "ReferenceError: window is not defined"
// → prerendering "/" падает → build failed.
//
// Потребители SPEED_BUCKETS/speedBucketFor (speed-profile-chart.tsx,
// session-compare.tsx) используют dynamic import для самого MapTrack
// (ssr: false) — но статический import типов/констант из map-track.tsx
// всё равно тянет весь модуль, включая leaflet.
//
// Решение без костылей: вынести чистые типы/данные в отдельный модуль
// (lib/speed-buckets.ts). map-track.tsx импортирует их отсюда; все
// потребители тоже импортируют отсюда. Никакого транзитивного leaflet
// при статической генерации.

export interface SpeedBucket {
  maxKmh: number;
  color: string;
  label: string;
}

// v2.9.8: тепловая карта скорости — трек, раскрашенный по скорости движения.
// Классическая телеметрическая шкала; границы бакетов в км/ч.
export const SPEED_BUCKETS: SpeedBucket[] = [
  { maxKmh: 30, color: "#10b981", label: "0–30" },   // emerald — город/стоянка
  { maxKmh: 60, color: "#65a30d", label: "30–60" },  // lime-600 — темнее 500-го: VLM отмечал сливание со светлыми тайлами
  { maxKmh: 90, color: "#eab308", label: "60–90" },  // yellow
  { maxKmh: 120, color: "#f97316", label: "90–120" }, // orange
  { maxKmh: Infinity, color: "#e11d48", label: "120+" }, // rose — быстро
];

// v2.9.9: экспортирован для спидограммы — единая шкала бакетов карты и графика
export function speedBucketFor(kmh: number): number {
  for (let i = 0; i < SPEED_BUCKETS.length; i++) {
    if (kmh <= SPEED_BUCKETS[i].maxKmh) return i;
  }
  return SPEED_BUCKETS.length - 1;
}

// v2.9.7: цветной трек для сравнения поездок — каждая поездка своей полилинией
export interface ColoredTrack {
  points: Array<{ lat: number; lon: number }>;
  color: string;
  label?: string;
}
