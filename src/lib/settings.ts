// src/lib/settings.ts — Runtime-overridable settings (DB-backed, in-memory cached).
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

const TTL_MS = 60_000;

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
      logger.warn("settings cache refresh failed (non-fatal, fallback to env)", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      store.loading = null;
    }
  })();
  return store.loading;
}

export function getSettingSync(key: string): string {
  const store = getStore();
  if (Date.now() - store.loadedAt > TTL_MS && !store.loading) {
    void refreshCache();
  }
  const cached = store.cache.get(key);
  if (cached) return cached.value;
  const e = env();
  if (key === "TWO_GIS_API_KEY") return e.TWO_GIS_API_KEY;
  if (key === "TWO_GIS_PROXY_URL") return e.TWO_GIS_PROXY_URL;
  if (key === "OSRM_BASE_URL") return e.OSRM_BASE_URL;
  return "";
}

export async function getSetting(key: string): Promise<string> {
  const store = getStore();
  if (Date.now() - store.loadedAt > TTL_MS) {
    await refreshCache();
  }
  return getSettingSync(key);
}

// v2.18.0: прямой точечный read для записей, которых НЕТ в кэше настроек
// (geocode:* — тысячи строк). getSetting(key) гоняет refreshCache() — полную
// загрузку ВСЕЙ таблицы Setting в Map раз в 60с TTL; дешёвые точечные записи
// теперь читаются одним SELECT WHERE key = ? без этого churn'а.
export async function getSettingDirect(key: string): Promise<string> {
  try {
    const res = await libsql.execute({
      sql: "SELECT value FROM Setting WHERE key = ?",
      args: [key],
    });
    if (res.rows.length === 0) return "";
    return String((res.rows[0] as Record<string, unknown>).value);
  } catch {
    return "";
  }
}

export async function setSetting(key: string, value: string, updatedBy?: string): Promise<void> {
  await upsertSetting(key, value, updatedBy ?? null);
  getStore().cache.set(key, { value, updatedAt: Date.now() });
  logger.info("setting updated", { key, updatedBy });
}

// v2.16.0 (D-14): ЕДИНЫЙ UPSERT строки Setting — раньше тот же SQL копировался
// в settings.ts и дважды в ingest-trace.ts (расползание правок при изменении схемы).
export async function upsertSetting(key: string, value: string, updatedBy: string | null): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `INSERT INTO Setting (key, value, updatedAt, updatedBy)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
    args: [key, value, now, updatedBy],
  });
}

export async function ensureSettingsLoaded(): Promise<void> {
  await refreshCache();
}

export async function listOverridableSettings(): Promise<
  Array<{ key: string; value: string; source: "db" | "env"; updatedAt?: string; isSensitive: boolean }>
> {
  const store = getStore();
  if (Date.now() - store.loadedAt > TTL_MS) {
    await refreshCache();
  }
  const e = env();
  const known: Array<{ key: string; envDefault: string; isSensitive: boolean }> = [
    { key: "TWO_GIS_API_KEY", envDefault: e.TWO_GIS_API_KEY, isSensitive: true },
    { key: "TWO_GIS_PROXY_URL", envDefault: e.TWO_GIS_PROXY_URL, isSensitive: false },
    { key: "OSRM_BASE_URL", envDefault: e.OSRM_BASE_URL, isSensitive: false },
  ];
  return known.map((k) => {
    const db = store.cache.get(k.key);
    return {
      key: k.key,
      value: db?.value ?? k.envDefault,
      source: db ? ("db" as const) : ("env" as const),
      updatedAt: db ? new Date(db.updatedAt).toISOString() : undefined,
      isSensitive: k.isSensitive,
    };
  });
}
