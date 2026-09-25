import Redis from "ioredis"

let _redis: Redis | null = null

function getRedis(): Redis | null {
  if (_redis) return _redis
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  _redis = new Redis(redisUrl, { lazyConnect: true })
  _redis.on("error", () => {})
  return _redis
}

export function resetRedis(): void {
  _redis = null
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec = 30): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value))
  } catch {
    // silently fail – cache is optional
  }
}

// ---------------------------------------------------------------------------
// In-process TTL cache with explicit invalidation
// ---------------------------------------------------------------------------

interface MemoryCacheEntry {
  value: unknown
  expiresAt: number
}

const _memoryCache = new Map<string, MemoryCacheEntry>()

/** Returns the cached value for `key` if present and not yet expired. */
export function memoryCacheGet<T>(key: string): T | null {
  const entry = _memoryCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    _memoryCache.delete(key)
    return null
  }
  return entry.value as T
}

/** Stores `value` under `key`; the TTL is a safety net for changes nobody invalidates. */
export function memoryCacheSet(key: string, value: unknown, ttlMs: number): void {
  _memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

/**
 * Removes `key` from the in-process cache and logs the invalidation.
 * Returns true when a live entry was evicted.
 */
export function invalidateCacheKey(key: string, reason = "manual"): boolean {
  const existed = _memoryCache.delete(key)
  console.log(`[cache] invalidated key=${key} reason=${reason} evicted=${existed}`)
  return existed
}

// ---------------------------------------------------------------------------
// Treasury balances cache (GET /api/treasury/balances)
// ---------------------------------------------------------------------------

export type TreasuryBalances = Array<{ token: string; balance: string }>

export const BALANCE_CACHE_KEY = "treasury:balances"
export const BALANCE_CACHE_TTL_MS = 5_000

export function getBalanceCache(): TreasuryBalances | null {
  return memoryCacheGet<TreasuryBalances>(BALANCE_CACHE_KEY)
}

export function setBalanceCache(data: TreasuryBalances): void {
  memoryCacheSet(BALANCE_CACHE_KEY, data, BALANCE_CACHE_TTL_MS)
}

/** Evicts cached balances so the next GET /balances re-reads them from RPC. */
export function invalidateBalanceCache(reason?: string): boolean {
  return invalidateCacheKey(BALANCE_CACHE_KEY, reason)
}
