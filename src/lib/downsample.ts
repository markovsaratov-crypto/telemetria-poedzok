// src/lib/downsample.ts — v2.38.1 (ревью F24): прореживание GPS-треков для рендера.
//
// Единый конвейер трека (session-track.ts / /api/sessions/[id]/track) отдаёт
// полный массив точек — для KPI и скоростного профиля это правильно, но для
// РЕНДЕРА (Leaflet-полилинии, CircleMarker'ы) полный трек = 56K точек на запись
// и сотни тысяч в период-агрегате → мегабайты DOM/SVG-геометрии и jank при
// pan/zoom. Весь остальной конвейер давно с потолками (speedProfile 240/720,
// события 4000/3000/2000) — карта была единственной поверхностью без лимита.
//
// Здесь — чистые функции равномерного сэмпла: первая/последняя точки
// сохраняются всегда (старт/финиш трека), интерполяции нет — значения
// (скорость и пр.) остаются при СВОИХ оставшихся точках. Даунсемп делается
// только в слое рендера (map-track.tsx / aggregateTrack) — форма ответа
// /api/track не меняется, другие потребители полных данных не затронуты.

/**
 * Индексы равномерного сэмпла длины `length`: ≤ max индексов, отсортированы,
 * 0 и length−1 присутствуют всегда (max ≥ 2 и length > max).
 */
export function sampleIndices(length: number, max: number): number[] {
  if (length <= 0 || max <= 0) return [];
  if (length === 1) return [0];
  if (max <= 1) return [0];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (max - 1);
  const out: number[] = new Array(max);
  for (let i = 0; i < max - 1; i++) out[i] = Math.round(i * step);
  out[max - 1] = length - 1;
  return out;
}

/**
 * Равномерный сэмпл массива: ≤ max элементов, первый/последний сохранены.
 * Массив ≤ max возвращается как есть (без копирования) — функция чистая.
 */
export function downsampleUniform<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max || max <= 0) return items as T[];
  const idx = sampleIndices(items.length, max);
  return idx.map((i) => items[i]);
}
