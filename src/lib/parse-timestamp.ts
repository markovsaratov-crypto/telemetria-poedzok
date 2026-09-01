// src/lib/parse-timestamp.ts — v2.11.0 (АУДИТ C-12): единый парсер времени для
// CSV/ZIP-импорта. Раньше дублировался в двух роутах с разным поведением:
// ZIP-версия делала Number(iso) = NaN → BigInt(NaN) → 500 на реальных
// SensorLogger-экспортах (ISO-строки в Location.csv).
// Форматы: нс (>1e15 → /1e6), мс (>1e12), сек (>1e9 → ×1000), ISO-строка.
// Невалидное → null (вызывающий решает: пропустить или reject).
export function parseTimestamp(raw: string): number | null {
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") {
    if (num > 1e15) return Math.floor(num / 1e6); // наносекунды
    if (num > 1e12) return num; // мс
    if (num > 1e9) return num * 1000; // сек → мс
    return null; // не правдоподобное число
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}
