// src/lib/rate-limit.ts — sliding window, in-memory (sandbox) / Redis (prod, §6.3).
// Блокер №1 FIX: RATE_LIMIT_MAX_INGEST=120 покрывает TARGET_LOAD_RPM=100 × 1.2.
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

// Заглушка под Redis (когда REDIS_URL задан — в sandbox не используется)
class RedisRateLimiter implements IRateLimiter {
  async check(key: string, limit: number, windowSec: number) {
    // В sandbox всегда fallback на memory. Реальный Redis через @upstash/redis — прод-расширение.
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
