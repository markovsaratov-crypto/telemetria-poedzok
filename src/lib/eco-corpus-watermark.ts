// src/lib/eco-corpus-watermark.ts — v2.40.3 (ревью 19-j, критик RR-2
// «рестарт-бёрн»): персист watermark корпус-калибровки EcoScore.
//
// Проблема: watermark инкрементального sweep (v2.38.2/F59) жил ТОЛЬКО в
// памяти процесса — каждый рестарт/деплой/эвикция изолята (18.09: 8 эвикций
// за утро) запускал ПОЛНЫЙ sweep: чтение всех точек всех финализированных
// записей. На free tier D1 это прямо жгло дневную квоту чтений.
//
// Решение: после успешного sweep watermark сериализуется в Setting
// (компактный JSON), при холодном старте читается оттуда — диф сразу
// продолжается инкрементально. Цена — 1 маленькая строка Setting на чтение
// и на запись; обе операции НЕ фатальны: любой сбой (нет строки, исчерпана
// квота, битый JSON) = деградация к прежнему поведению (полный sweep).
// Ключ попадает в ночной бэкап — watermark восстанавливается с данными.
//
// Файл НАМЕРЕННО чистый (без импортов): сериализация — чистые функции,
// покрытые юнит-тестами (tests/eco-watermark.test.ts); вся работа с БД —
// в eco-corpus.ts (loadPersistedWatermark/persistWatermark).

/** rates методологии одной записи корпуса (null — ниже gate <60, не калибрует). */
export interface SessionRates {
  braking: number;
  accel: number;
  jerk: number;
}

/** Watermark инкрементального sweep (F59): rates записи + число точек, ПО
 *  КОТОРОМУ они посчитаны (изменение pointCount = backfill → пересчёт записи). */
export type CorpusWatermark = Map<string, { rates: SessionRates | null; pointCount: number }>;

export const CORPUS_WATERMARK_KEY = "eco.corpus.watermark.v1";
export const CORPUS_WATERMARK_MAX_BYTES = 512 * 1024; // стоп-кран: раздувшийся корпус не пишем в Setting

/** Компактный формат: rates → кортеж [braking, accel, jerk] (−~40 % байт
 *  против объектов с именами полей на сотни сессий). */
export type PersistedWatermark = {
  v: 1;
  wm: Record<string, { r: [number, number, number] | null; pc: number }>;
};

export function serializeWatermark(wm: CorpusWatermark): string {
  const out: PersistedWatermark["wm"] = {};
  for (const [id, e] of wm) {
    out[id] = { r: e.rates ? [e.rates.braking, e.rates.accel, e.rates.jerk] : null, pc: e.pointCount };
  }
  return JSON.stringify({ v: 1, wm: out } satisfies PersistedWatermark);
}

export function watermarkSizeBytes(json: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(json, "utf8") : new TextEncoder().encode(json).length;
}

/**
 * Обратная сериализация. Устойчива к битому/чужому формату: вернёт null
 * для нераспознаваемого payload; некорректные ОТДЕЛЬНЫЕ записи отбрасываются
 * поштучно (валидные выживают). Запись с валидным pointCount, но кривыми
 * rates трактуется как «ниже gate» (rates=null) — она не пересчитывается
 * каждый sweep, пока pointCount не изменится (семантика F59 сохранена).
 */
export function deserializeWatermark(json: string): CorpusWatermark | null {
  try {
    const parsed = JSON.parse(json) as PersistedWatermark | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.wm !== "object" || parsed.wm === null) return null;
    const out: CorpusWatermark = new Map();
    for (const [id, e] of Object.entries(parsed.wm)) {
      if (!e || typeof e.pc !== "number" || !Number.isFinite(e.pc)) continue;
      const r = e.r;
      const rates: SessionRates | null =
        Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === "number" && Number.isFinite(x))
          ? { braking: r[0], accel: r[1], jerk: r[2] }
          : null;
      out.set(id, { rates, pointCount: e.pc });
    }
    return out;
  } catch {
    return null; // битый JSON — как отсутствующий: полный sweep перезапишет
  }
}
