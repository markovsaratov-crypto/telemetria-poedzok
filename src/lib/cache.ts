// src/lib/cache.ts — двухуровневый кэш маршрутизации (LRU + SQLite), snap-to-grid ~55 м + ToD (§3.2)
import { db } from "./db";

const LRU_MAX = 500;
const lru = new Map<string, { result: string; ts: number }>();

// Snap-to-grid: ~55 м на широте 56° → ~0.0005 градуса
const SNAP = 0.0005;

export function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

// ToD bucket: 0,3,6,9,12,15,18,21 (час, UTC)
export function todBucket(date = new Date()): number {
  const h = date.getUTCHours();
  return Math.floor(h / 3) * 3;
}

export function cacheHash(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
  bucket: number
): string {
  const s = `${snap(startLat)},${snap(startLon)},${snap(endLat)},${snap(endLon)},${bucket}`;
  // Простой хеш (без crypto для скорости)
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `c${(h >>> 0).toString(36)}`;
}

const LRU_TTL_MS = 5 * 60 * 1000; // 5 минут
const PERSIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

export async function cacheGet(hash: string): Promise<string | null> {
  // 1. LRU
  const lruHit = lru.get(hash);
  if (lruHit && Date.now() - lruHit.ts < LRU_TTL_MS) {
    // touch
    lru.delete(hash);
    lru.set(hash, lruHit);
    return lruHit.result;
  }
  // 2. SQLite persistent
  const row = await db.routeCache.findUnique({
    where: { hash },
  });
  // v2.9.4 fix: expiresAt — ISO-строка (libsql сериализует Date в ISO);
  // прямое сравнение строки с Date давало NaN → персистентный кэш никогда не срабатывал
  if (row && new Date(row.expiresAt) > new Date()) {
    // backfill LRU
    lru.set(hash, { result: row.result, ts: Date.now() });
    if (lru.size > LRU_MAX) {
      const oldest = lru.keys().next().value;
      if (oldest) lru.delete(oldest);
    }
    return row.result;
  }
  return null;
}

export async function cacheSet(hash: string, result: string, bucket: number, routeId?: string): Promise<void> {
  // LRU
  lru.set(hash, { result, ts: Date.now() });
  if (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest) lru.delete(oldest);
  }
  // SQLite
  const expiresAt = new Date(Date.now() + PERSIST_TTL_MS);
  await db.routeCache.upsert({
    where: { hash },
    create: { hash, result, todBucket: bucket, routeId, expiresAt },
    update: { result, todBucket: bucket, routeId, expiresAt },
  });
}

export function lruStats() {
  return { size: lru.size, max: LRU_MAX };
}
