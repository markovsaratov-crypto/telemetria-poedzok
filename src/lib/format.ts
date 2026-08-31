// src/lib/format.ts — форматирование дат, чисел, длительности для UI.

const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateShort = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return dateFmt.format(d);
}

export function fmtDateShort(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return dateShort.format(d);
}

export function fmtDuration(ms?: number | null): string {
  if (ms == null || isNaN(ms) || ms <= 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

// v2.10.3 (эргономика): длительность из СЕКУНД — как fmtDuration, но без ms-аргумента
// и без тире для нуля (для легенд/тайлов, где 0 — валидное значение).
// fmtSecShort — компактная подпись легенды: «45 сек» / «22 мин» / «2 ч 5 мин».
export function fmtSecShort(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "0 сек";
  const s = Math.round(sec);
  if (s < 60) return `${s} сек`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

// fmtSecFull — с точностью до секунд (тултипы/значения тайлов): «11 мин 20 сек».
export function fmtSecFull(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "0 сек";
  const s = Math.round(sec);
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} мин ${rs} сек` : `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function fmtBytes(bytes?: number | null): string {
  if (bytes == null || isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

export function fmtNumber(n?: number | null, digits = 0): string {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

// Средняя скорость по точкам (м/с → км/ч)
export function avgSpeed(
  points: Array<{ speed?: number | null; timestamp?: number }>
): number | null {
  const withSpeed = points.filter(
    (p) => typeof p.speed === "number" && p.speed > 0
  );
  if (withSpeed.length === 0) return null;
  const sum = withSpeed.reduce((acc, p) => acc + (p.speed as number), 0);
  return Math.round((sum / withSpeed.length) * 3.6 * 10) / 10; // м/с → км/ч
}

// P2-14: канонический гаверсинус вынесен в src/lib/geo.ts (было 6 идентичных копий).
import { haversineM as haversine } from "./geo";
export { haversine };

// Суммарная длина трека (метры)
export function trackDistance(
  points: Array<{ lat: number; lon: number }>
): number {
  if (points.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversine(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
  }
  return d;
}
