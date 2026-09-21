// src/lib/cache-versions.ts — v2.41.0 (N-8 «лжесвежесть кэша частичным
// write-through»): ВЕРСИИ КОНВЕЙЕРОВ ПО ПОЛЯМ кэша сессии.
//
// ПРОБЛЕМА (прод-кейс 20.09, квота умерла mid-flight): строковый
// Session.cacheVersion проставляется ЛЮБЫМ батч-роутом при пересчёте СВОЕГО
// поля — stats/batch пересчитал statsCache конвейером v2.40.7 и застампил
// строку v10, а trackCache той же сессии остался от конвейера v2.40.6
// (ДО фильтра островов N-3) и УНАСЛЕДОВАЛ «свежесть» по строковой версии:
// isSessionCacheFresh(meta, ["track"]) формально отвечал «да», и 2 точки
// Казахстана (890 км от ядра трека) месяц жили на карте как «свежие».
//
// РЕШЕНИЕ: каждый payload несёт cacheV — версию СВОЕГО конвейера на момент
// записи. Свежесть поля = (строка свежа) И (payload.cacheV === константа
// поля). Payload'ы БЕЗ cacheV (все, записанные до v2.41.0) трактуются как
// версия 0 → протухшие → пересчёт. Чтобы это не выжгло квоту «первым
// зрителем» (урок N-6), сразу после деплоя запускается бюджетный
// backfill-caches (admin-роут) — офлайн-проход пересчитывает протухшие поля
// ДО открытия дашборда.
//
// Значения независимы друг от друга и от SESSION_CACHE_VERSION (схема):
// bump ПОЛЯ инвалидирует только его конвейер. История:
//   stats:  1 = v2.27.0 базовый предрасчёт;
//           2 = v2.40.7 (N-3: телепорт-фильтр в дистанции/avgSpeed/gapTime);
//   events: 1 = v2.19.0/v2.27.0 базовый (N-3 конвейер событий не менял);
//   track:  1 = v2.27.0 базовый;
//           2 = v2.40.7 (N-3: фильтр островов телепортов в points/bounds).
//
// Модуль — ЛИСТ графа импортов (никаких зависимостей): его импортируют и
// конвейеры (штамп в payload), и session-cache.ts (проверка свежести) —
// цикл session-cache ⇄ конвейеры исключён.

export type SessionCacheField = "stats" | "events" | "track";

/** Текущие версии конвейеров трёх кэш-полей сессии (см. историю выше). */
export const CACHE_PIPELINE_VERSIONS: Record<SessionCacheField, number> = {
  stats: 2,
  events: 1,
  track: 2,
};

/**
 * Читает cacheV из разобранного payload'а кэша. Отсутствие поля = 0
 * (payload'ы всех конвейеров до v2.41.0) — честно «протухший».
 *
 * statsCache хранит ОБЁРТКУ SessionStatsResult {kind:"empty"|"full",
 * payload:{…}} — штамп внутри payload, на уровень глубже top-level
 * (конвейер статов кладёт cacheV в сам payload, как events/track).
 * Обёртка разворачивается здесь — иначе детектор НИКОГДА не увидел бы
 * штамп статов (найдено отладкой бэкфилла 21.09: «остаток 79» при
 * застампленных 77 строках).
 */
export function payloadCacheV(parsed: unknown): number {
  if (parsed == null || typeof parsed !== "object") return 0;
  const obj = parsed as { cacheV?: unknown; kind?: unknown; payload?: unknown };
  if (typeof obj.cacheV === "number" && Number.isFinite(obj.cacheV)) return obj.cacheV;
  if ((obj.kind === "empty" || obj.kind === "full") && obj.payload != null && typeof obj.payload === "object") {
    const inner = (obj.payload as { cacheV?: unknown }).cacheV;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  return 0;
}
