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

// v2.16.0: fmtDateShort/fmtDuration/fmtCountRu удалены — 0 потребителей
// (все UI-компоненты используют fmtDate/fmtSecShort/fmtSecFull/fmtDurMin/
// fmtNumber/pluralRu; дубли форматов — источник расхождений).

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

// v2.12.0 (D-9, округления): длительность из МИНУТ — единый человекочитаемый формат
// «45 сек» / «68 мин» / «1 ч 32 мин» / «5 ч». Заменяет зоопарк «92 мин» vs «5 ч 7 м»
// и «0 мин» для записей короче минуты.
export function fmtDurMin(min?: number | null): string {
  if (min == null || !Number.isFinite(min) || min < 0) return "—";
  const totalSec = Math.round(min * 60);
  if (totalSec < 60) return `${totalSec} сек`;
  const totalMin = Math.round(min);
  if (totalMin < 60) return `${totalMin} мин`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

// v2.12.0 (D-9): русская плюрализация — «1 сегмент / 2 сегмента / 5 сегментов».
// forms = [единственное, парное (2–4), множественное (5+, 11–14)].
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

// v2.12.0 (D-3): штрафные/призовые баллы EcoScore с плюрализацией.
// Дробные значения в русском требуют родительный ед.ч.: «−18,9 балла».
// Целые: «0 баллов», «1 балл», «2 балла», «5 баллов». Минус-ноль не выводим.
export function fmtPointsRu(p: number): string {
  const rounded = Math.round(p * 10) / 10;
  if (rounded === 0) return "0 баллов";
  const sign = rounded < 0 ? "−" : "";
  const abs = Math.abs(rounded);
  if (Number.isInteger(abs)) return `${sign}${fmtNumber(abs)} ${pluralRu(abs, ["балл", "балла", "баллов"])}`;
  return `${sign}${abs.toFixed(1).replace(".", ",")} балла`;
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

// P2-14: канонический гаверсинус и длина трека — в src/lib/geo.ts
// (было 6 идентичных копий; пере-экспорт из format удалён — 0 потребителей).
import { trackDistanceM } from "./geo";

// Суммарная длина трека (метры) — делегирует канонической geo.trackDistanceM.
export function trackDistance(
  points: Array<{ lat: number; lon: number }>
): number {
  return trackDistanceM(points);
}
