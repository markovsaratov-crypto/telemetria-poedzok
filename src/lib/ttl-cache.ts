// src/lib/ttl-cache.ts — v2.19.0: маленький in-memory TTL-кэш для батч-роутов
// (/api/stats/batch, /api/events/batch, /api/track/batch).
//
// Зачем: холодный полный батч-статс на проде стоит ~10–22 с (JOIN ~25k строк
// через Turso-HTTP). Клиентский кэш react-query (staleTime 30с) спасает только
// одну вкладку одного браузера; серверный TTL-кэш делит результат между
// вкладками/устройствами и переживает истечение клиентского staleTime.
// v2.29.0 (кодревью): комментарий «ключ — только ids» УСТАРЕЛ с v2.23.0 —
// сессии РАЗБИТЫ по пользователям, и ключи батч-кэшей включают скоуп
// запрашивающего (см. вызовы с scope-префиксом в роутах). Ключ = скоуп + ids.
//
// Гарантии: запись не живёт дольше ttlMs; переполнение выталкивает самую
// давнюю по доступу запись (Map хранит порядок вставки, get перекладывает
// в конец); Map на globalThis переживает HMR-пересоздания модулей.
//
// Инвалидация по данным НЕ нужна: TTL 30с сопоставим с клиентским staleTime,
// а ЖИВЫЕ (recording) сессии фронтенд обновляет поштучным роутом каждые 15с
// (мимо батча) — батч-кэш не может скрыть прогресс живой записи дольше 30с,
// ровно как и клиентский кэш.
//
// v2.41.0 (P0-C, m-22 «TTL без SWR»): getStale — SWR-ветка для рендер-режима
// батч-роутов. Проблема: TTL 60 с истекал быстрее, чем пользователь
// возвращался на вкладку (период-агрегат 60с staleTime) — повтор = полный
// путь (десятки чтений D1 + 3,1 с сериализации). Теперь: просроченная запись
// отдаётся ЕЩЁ один ttl-период (stale-окно = ttl), а ревалидация запускается
// фоном ОДИН раз на ключ (одиночный полёт: конкурентные запросы не устраивают
// шторм пересчётов). Свежий set() снимает одиночный полёт.

interface Entry<T> {
  value: T;
  expiresAt: number;
  /** v2.41.0: момент, до которого запись можно отдавать как STALE (SWR). */
  staleUntil: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 32,
  ) {}

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU-жест: свежедоступная запись уходит в конец порядка вытеснения
    this.store.delete(key);
    this.store.set(key, e);
    return e.value;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, staleUntil: Date.now() + 2 * this.ttlMs });
    this.revalidating.delete(key); // свежая запись — одиночный полёт снят
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  // ——— v2.41.0 (P0-C): SWR — просроченное значение + фоновая ревалидация ———
  private readonly revalidating = new Set<string>();

  /**
   * SWR-чтение: свежая запись — как обычный get (stale: false); ПРОСРОЧЕННАЯ,
   * но младше 2×ttl — отдаётся (stale: true), и ОДИН раз на ключ запускается
   * onStale (фоновая ревалидация вызывающего). Запись старше 2×ttl/отсутствующая
   * — undefined (честный miss). Запись в stale-окне ОСТАЁТСЯ в хранилище:
   * конкурентные запросы до завершения ревалидации получают то же stale-
   * значение (анти-стампедо), а не полный пересчёт каждый. Если фоновая
   * ревалидация молча упала — флаг одиночного полёта живёт до 2×ttl, потом
   * честный miss = полный путь (самовосстановление, ограничено окном).
   */
  getStale(key: string, onStale?: () => void): { value: T; stale: boolean } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt > Date.now()) {
      // свежая — LRU-жест, как в get()
      this.store.delete(key);
      this.store.set(key, e);
      return { value: e.value, stale: false };
    }
    // просроченная за пределами stale-окна — честный miss
    if (e.staleUntil <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // stale-окно: запись живёт до завершения ревалидации, LRU-жест сохранён
    this.store.delete(key);
    this.store.set(key, e);
    if (onStale && !this.revalidating.has(key)) {
      this.revalidating.add(key); // одиночный полёт до следующего set()
      try {
        onStale();
      } catch {
        // ревалидация фоновая — сбой не должен ронять ответ
        this.revalidating.delete(key);
      }
    }
    return { value: e.value, stale: true };
  }
}

// Реестр именованных кэшей на globalThis: один экземпляр на процесс
// независимо от количества импортов и HMR-пересозданий модуля.
const globalForTtl = globalThis as unknown as { __ttlCacheRegistry?: Map<string, TtlCache<unknown>> };
const registry = globalForTtl.__ttlCacheRegistry ?? new Map<string, TtlCache<unknown>>();
globalForTtl.__ttlCacheRegistry = registry;

export function getTtlCache<T>(name: string, ttlMs: number, maxEntries = 32): TtlCache<T> {
  const existing = registry.get(name);
  if (existing instanceof TtlCache) return existing as TtlCache<T>;
  const created = new TtlCache<T>(ttlMs, maxEntries);
  registry.set(name, created as TtlCache<unknown>);
  return created;
}
