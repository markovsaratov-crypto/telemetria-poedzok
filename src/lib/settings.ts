// src/lib/settings.ts — Runtime-overridable settings (DB-backed, in-memory cached).
//
// Позволяет менять настройки (TWO_GIS_API_KEY и др.) без redeploy.
// Архитектура:
//   1. При первом обращении — lazy load всех Setting-записей из БД в кэш.
//   2. TTL 60 сек — после этого кэш автоматически обновляется.
//   3. setSetting() — пишет в БД И сразу обновляет кэш (без ожидания TTL).
//   4. Worker (in-process) и API routes используют один кэш (globalThis guard).
//
// Override priority: DB Setting > process.env
// Если в БД нет записи — fallback на env-переменную (env()).
//
// Список известных overridable ключей:
//   - TWO_GIS_API_KEY — API-ключ 2ГИС для routing chain
//   - OSRM_BASE_URL   — базовый URL OSRM-сервера
// (другие env-переменные не overridable — они нужны на этапе boot).

import { libsql } from "./db";
import { env } from "./env";
import { logger } from "./logger";

const GLOBAL_KEY = "__telemetriaSettings";
const g = globalThis as unknown as {
  [GLOBAL_KEY]?: {
    cache: Map<string, { value: string; updatedAt: number }>;
    loadedAt: number;
    loading: Promise<void> | null;
  };
};

const TTL_MS = 60_000; // 60 секунд

function getStore() {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cache: new Map<string, { value: string; updatedAt: number }>(),
      loadedAt: 0,
      loading: null,
    };
  }
  return g[GLOBAL_KEY]!;
}

async function refreshCache(): Promise<void> {
  const store = getStore();
  if (store.loading) return store.loading;

  store.loading = (async () => {
    try {
      const res = await libsql.execute("SELECT key, value, updatedAt FROM Setting");
      const next = new Map<string, { value: string; updatedAt: number }>();
      for (const row of res.rows) {
        const r = row as Record<string, unknown>;
        next.set(String(r.key), {
          value: String(r.value),
          updatedAt: new Date(String(r.updatedAt)).getTime(),
        });
      }
      store.cache = next;
      store.loadedAt = Date.now();
    } catch (err) {
      // Таблица может ещё не существовать после db:push на новом окружении —
      // логируем, но не роняем. В этом случае getSetting() вернёт env-значение.
      logger.warn("settings cache refresh failed (non-fatal, fallback to env)", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      store.loading = null;
    }
  })();

  return store.loading;
}

/**
 * Синхронный геттер — возвращает значение из кэша или fallback на env.
 * НЕ триггерит загрузку (используйте ensureSettingsLoaded() на старте).
 *
 * Priority: DB Setting (cache) > process.env (via env())
 */
export function getSettingSync(key: string): string {
  const store = getStore();
  // Если кэш протух — запускаем async refresh (но не ждём — вернём env на этот запрос)
  if (Date.now() - store.loadedAt > TTL_MS && !store.loading) {
    void refreshCache();
  }
  const cached = store.cache.get(key);
  if (cached) return cached.value;

  // Fallback на env для известных ключей
  const e = env();
  if (key === "TWO_GIS_API_KEY") return e.TWO_GIS_API_KEY;
  if (key === "OSRM_BASE_URL") return e.OSRM_BASE_URL;
  return "";
}

/**
 * Async геттер — гарантирует свежий кэш перед чтением.
 * Используется там, где критична актуальность (например перед записью в audit).
 */
export async function getSetting(key: string): Promise<string> {
  const store = getStore();
  if (Date.now() - store.loadedAt > TTL_MS) {
    await refreshCache();
  }
  return getSettingSync(key);
}

/**
 * Записывает setting в БД и обновляет кэш немедленно.
 * Audit: caller ответственен за writeAudit().
 */
export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string
): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `INSERT INTO Setting (key, value, updatedAt, updatedBy)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
    args: [key, value, now, updatedBy ?? null],
  });
  // Обновляем кэш немедленно
  getStore().cache.set(key, { value, updatedAt: Date.now() });
  logger.info("setting updated", { key, updatedBy });
}

/**
 * Загружает кэш при старте сервера (вызывается из instrumentation.ts).
 * Не падает, если БД недоступна — getSettingSync вернёт env-значение.
 */
export async function ensureSettingsLoaded(): Promise<void> {
  await refreshCache();
}

/**
 * Возвращает все known overridable settings (для /api/admin/settings GET).
 */
export async function listOverridableSettings(): Promise<
  Array<{ key: string; value: string; source: "db" | "env"; updatedAt?: string }>
> {
  const store = getStore();
  if (Date.now() - store.loadedAt > TTL_MS) {
    await refreshCache();
  }
  const e = env();
  const known: Array<{ key: string; envDefault: string; label: string; masked: boolean }> = [
    { key: "TWO_GIS_API_KEY", envDefault: e.TWO_GIS_API_KEY, label: "2ГИС API ключ", masked: true },
    { key: "OSRM_BASE_URL", envDefault: e.OSRM_BASE_URL, label: "OSRM базовый URL", masked: false },
  ];
  return known.map((k) => {
    const db = store.cache.get(k.key);
    return {
      key: k.key,
      value: db?.value ?? k.envDefault,
      source: db ? "db" : "env",
      updatedAt: db ? new Date(db.updatedAt).toISOString() : undefined,
    };
  });
}
