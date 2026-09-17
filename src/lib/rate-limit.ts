// src/lib/rate-limit.ts — sliding window, in-memory (единый инстанс; Redis —
// заявлен конфигом, но не реализован: при включении честно логируем fallback).
// Блокер №1 FIX: RATE_LIMIT_MAX_INGEST=120 покрывает TARGET_LOAD_RPM=100 × 1.2.
// v2.38.1 (ревью F10): env-импорт для checkLoginRateLimit (RATE_LIMIT_MAX_AUTH).
import { env } from "./env";
export interface IRateLimiter {
  check(
    key: string,
    limit: number,
    windowSec: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfter: number; limit: number; reset: number }>;
}

interface BucketEntry {
  timestamps: number[];
}

class MemoryRateLimiter implements IRateLimiter {
  private store = new Map<string, BucketEntry>();
  private maxBuckets = 10000;

  async check(key: string, limit: number, windowSec: number) {
    const now = Date.now();
    const winStart = now - windowSec * 1000;

    let bucket = this.store.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.store.set(key, bucket);
      // Evict if too many buckets (LRU-ish)
      if (this.store.size > this.maxBuckets) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey) this.store.delete(oldestKey);
      }
    }

    // Чистим старые
    bucket.timestamps = bucket.timestamps.filter((t) => t > winStart);

    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0];
      const reset = Math.ceil((oldest + windowSec * 1000) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((oldest + windowSec * 1000 - now) / 1000)),
        limit,
        reset,
      };
    }

    bucket.timestamps.push(now);
    const remaining = Math.max(0, limit - bucket.timestamps.length);
    const reset = Math.ceil((now + windowSec * 1000) / 1000);
    return { allowed: true, remaining, retryAfter: 0, limit, reset };
  }

  // Для тестов / метрик
  stats() {
    return { buckets: this.store.size, backend: "memory" };
  }
}

// v2.16.0 (B-9): Redis-«бэкенд» — ЧЕСТНЫЙ fallback. Раньше заглушка молча
// работала как memory при RATE_LIMIT_BACKEND=redis + REDIS_URL: оператор,
// включивший Redis в конфиге, получал memory-лимиты, счётчик
// rate_limit_fallback_total не инкрементировался никогда.
// v2.38.2 (ревью F34, doc): реализация Redis НЕ добавлена осознанно (текущий
// деплой — ОДИН инстанс, external Redis = новая внешняя зависимость и секрет);
// ограничение задокументировано в docs/OPERATIONS.md §3: при ≥2 инстансах
// (Render horizontal scaling) ВСЕ бакеты — per-instance, brute-force через
// разные инстансы умножает эффективный лимит на число инстансов. Общие бакеты
// вводить только при фактическом появлении второго инстанса: Upstash Redis
// или внешний rate-limit на прокси/CDN (WAF-правило).
class RedisRateLimiter implements IRateLimiter {
  private warned = false;
  async check(key: string, limit: number, windowSec: number) {
    if (!this.warned) {
      this.warned = true;
      try {
        const { inc } = await import("./metrics");
        inc("rate_limit_fallback_total", "Requests served by memory fallback while redis backend configured", 1);
      } catch {}
      // Динамический импорт логгера — избежать цикла (logger без зависимостей,
      // но держим паттерн ленивых зависимостей в этом модуле edge-безопасным)
      console.warn(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg: "RATE_LIMIT_BACKEND=redis configured, but Redis is NOT implemented — falling back to in-memory limiter (single instance only)" }));
    }
    return memLimiter.check(key, limit, windowSec);
  }
}

const memLimiter = new MemoryRateLimiter();

let instance: IRateLimiter | null = null;
export function createRateLimiter(): IRateLimiter {
  if (instance) return instance;
  const backend = process.env.RATE_LIMIT_BACKEND;
  if (backend === "redis" && process.env.REDIS_URL) {
    instance = new RedisRateLimiter();
  } else {
    instance = memLimiter;
  }
  return instance;
}

export function getRateLimiterStats() {
  return memLimiter.stats();
}

// Утилита: построение ключа бакета
export function rlKey(scope: string, ...parts: (string | undefined)[]) {
  return `rl:${scope}:${parts.filter(Boolean).join(":")}`;
}

// v2.38.1 (ревью F10): логин лимитируется не только по IP (гейт прокси,
// auth:login), но и по ПАРЕ логин+IP — brute-force одного логина не может
// запереть окно другого аккаунта, а владелец не блокируется сканером
// (частный случай: клиенты за CDN/ NAT делят IP, но не логин). Ключ бакета
// ДРУГОЙ (auth:login-cred), поэтому АУДИТ C-19 не нарушается: лимит
// auth:login прокси не списывается дважды — раньше роут проверял ТОТ ЖЕ ключ
// rl:auth:login:<ip>, и 5 попыток/мин превращались в ~2,5.
export async function checkLoginRateLimit(
  login: string,
  ip: string
): Promise<{ allowed: boolean; retryAfter: number }> {
  const e = env();
  const r = await createRateLimiter().check(
    rlKey("auth:login-cred", ip, login.trim().toLowerCase().slice(0, 64)),
    e.RATE_LIMIT_MAX_AUTH,
    60
  );
  return { allowed: r.allowed, retryAfter: r.retryAfter };
}
