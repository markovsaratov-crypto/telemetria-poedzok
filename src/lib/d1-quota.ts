// src/lib/d1-quota.ts — v2.40.9 (Pack C, m-20): ЧЕСТНОЕ состояние дневной квоты D1.
//
// ПРОБЛЕМА (m-20, инцидент 20.09 17:44 UTC): /health отвечал db:ok за 2 минуты
// до доказанного исчерпания read-квоты — проба SELECT 1 читает 0 строк и
// ПРОХОДИТ при мёртвой квоте (D1 отклоняет только запросы, которым нужны
// чтения). Индикатор жил в параллельной реальности с данными.
//
// РЕШЕНИЕ — sticky-флаг на globalThis, который ставится/снимается там, где
// видны РЕАЛЬНЫЕ исходы запросов (db-d1.ts — единственный транспорт к D1):
//   • markD1ReadQuotaExhausted() — каждый пойманный «exceeded … daily row
//     READ limit» (шлюз отдаёт текст D1_ERROR с d1:true);
//   • clearD1QuotaIfAlive() — каждый УСПЕШНЫЙ ответ с meta.rowsRead > 0
//     доказывает, что квота жива → флаг снят (раннее восстановление после
//     00:00 UTC, если первый показ данных случился до первого /health);
//   • квота D1 сбрасывается детерминированно в 00:00 UTC — флаг ДОЙДЕТ до
//     конца суток сам: isD1ReadQuotaExhausted() честно возвращает false,
//     когда наступила полночь ПОСЛЕ отметки (ноль дополнительной квоты на
//     «проверку выздоровления» — SELECT 1 для этого бесполезен по построению).
//
// Модуль — ЛИСТ графа (никаких импортов): используется db.ts (ре-экспорт
// isD1QuotaError на прежнем месте), db-d1.ts, /health и metrics.
// Write-квота (rows_written, лимит 100 тыс.) — симметричный флаг: инжест
// продолжает писать, но finalize/backfill честно видят свою деградацию.

/** Текст ошибки D1 при исчерпании дневного лимита ЧТЕНИЙ строк. */
export function isD1ReadQuotaError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /exceeded D1'?s free tier daily row read limit/i.test(err.message)
  );
}

/** Текст ошибки D1 при исчерпании дневного лимита ЗАПИСЕЙ строк. */
export function isD1WriteQuotaError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /exceeded D1'?s free tier daily row write limit/i.test(err.message)
  );
}

/** Любая квота D1 (read|write) — прежняя семантика db.ts, единый детектор. */
export function isD1QuotaError(err: unknown): boolean {
  return isD1ReadQuotaError(err) || isD1WriteQuotaError(err);
}

// ——— sticky-состояние на globalThis (переживает HMR, умирает с процессом —
// честно: новый процесс либо поймает ошибку заново, либо квота жива) ———
export interface D1QuotaFlags {
  readExhaustedAt: number | null;
  writeExhaustedAt: number | null;
}

const GLOBAL_KEY = "__telematD1QuotaFlags";
const g = globalThis as unknown as { [GLOBAL_KEY]?: D1QuotaFlags };

function flags(): D1QuotaFlags {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { readExhaustedAt: null, writeExhaustedAt: null };
  return g[GLOBAL_KEY]!;
}

/** Следующая полночь UTC ПОСЛЕ ts (сброс квоты D1 — 00:00 UTC). */
export function nextUtcMidnight(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/** Отметить исчерпание READ-квоты (вызов из db-d1.ts на ошибке шлюза). */
export function markD1ReadQuotaExhausted(now: number = Date.now()): void {
  const f = flags();
  if (f.readExhaustedAt == null || now < f.readExhaustedAt) f.readExhaustedAt = now;
}

/** Отметить исчерпание WRITE-квоты. */
export function markD1WriteQuotaExhausted(now: number = Date.now()): void {
  const f = flags();
  if (f.writeExhaustedAt == null || now < f.writeExhaustedAt) f.writeExhaustedAt = now;
}

/**
 * Успешный запрос с фактами чтения/записи строк — квота жива, флаги сняты.
 * Вызывается из toResultSet (db-d1.ts) на КАЖДОМ успешном ответе шлюза.
 */
export function clearD1QuotaIfAlive(rowsRead = 0, rowsWritten = 0): void {
  const f = flags();
  if (rowsRead > 0 && f.readExhaustedAt != null) f.readExhaustedAt = null;
  if (rowsWritten > 0 && f.writeExhaustedAt != null) f.writeExhaustedAt = null;
}

/** READ-квота считается исчерпанной? (полночь UTC после отметки = сброс). */
export function isD1ReadQuotaExhausted(now: number = Date.now()): boolean {
  const at = flags().readExhaustedAt;
  if (at == null) return false;
  if (now >= nextUtcMidnight(at)) {
    flags().readExhaustedAt = null; // сброс суток пришёл — квота восстановлена
    return false;
  }
  return true;
}

/** WRITE-квота исчерпана? (та же семантика полуночи). */
export function isD1WriteQuotaExhausted(now: number = Date.now()): boolean {
  const at = flags().writeExhaustedAt;
  if (at == null) return false;
  if (now >= nextUtcMidnight(at)) {
    flags().writeExhaustedAt = null;
    return false;
  }
  return true;
}

/** Снимок для /health и метрик (ISO-метки; null = квота жива). */
export function d1QuotaSnapshot(now: number = Date.now()): {
  readExhaustedAt: string | null;
  writeExhaustedAt: string | null;
  readExhausted: boolean;
  writeExhausted: boolean;
} {
  return {
    readExhaustedAt: flags().readExhaustedAt ? new Date(flags().readExhaustedAt!).toISOString() : null,
    writeExhaustedAt: flags().writeExhaustedAt ? new Date(flags().writeExhaustedAt!).toISOString() : null,
    readExhausted: isD1ReadQuotaExhausted(now),
    writeExhausted: isD1WriteQuotaExhausted(now),
  };
}

/** Сброс флагов (тесты / явный сброс оператором). */
export function resetD1QuotaFlagsForTests(): void {
  g[GLOBAL_KEY] = { readExhaustedAt: null, writeExhaustedAt: null };
}
