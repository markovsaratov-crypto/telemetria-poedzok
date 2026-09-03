// src/lib/ttl-cache.ts — v2.19.0: маленький in-memory TTL-кэш для батч-роутов
// (/api/stats/batch, /api/events/batch, /api/track/batch).
//
// Зачем: холодный полный батч-статс на проде стоит ~10–22 с (JOIN ~25k строк
// через Turso-HTTP). Клиентский кэш react-query (staleTime 30с) спасает только
// одну вкладку одного браузера; серверный TTL-кэш делит результат между
// вкладками/устройствами и переживает истечение клиентского staleTime.
// Данные для одного набора id авторизованными пользователями читаются
// одинаково (сессии не разбиты по пользователям), поэтому ключ — только ids.
//
// Гарантии: запись не живёт дольше ttlMs; переполнение выталкивает самую
// давнюю по доступу запись (Map хранит порядок вставки, get перекладывает
// в конец); Map на globalThis переживает HMR-пересоздания модулей.
//
// Инвалидация по данным НЕ нужна: TTL 30с сопоставим с клиентским staleTime,
// а ЖИВЫЕ (recording) сессии фронтенд обновляет поштучным роутом каждые 15с
// (мимо батча) — батч-кэш не может скрыть прогресс живой записи дольше 30с,
// ровно как и клиентский кэш.

interface Entry<T> {
  value: T;
  expiresAt: number;
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
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
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
