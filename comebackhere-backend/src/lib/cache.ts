import Redis from "ioredis"
import { logger } from "./logger.js"

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

export async function cacheDelete(key: string): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.del(key)
  } catch {
    // Cache failures must not affect API availability.
  }
}

export async function cacheTryLock(key: string, ttlMs: number): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true
  try {
    return (await redis.set(key, "1", "PX", ttlMs, "NX")) === "OK"
  } catch {
    return true
  }
}

export async function cacheReleaseLock(key: string): Promise<void> {
  await cacheDelete(key)
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
  logger.info({ key, reason, evicted: existed }, "Cache key invalidated")
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

// ---------------------------------------------------------------------------
// Merchant profile cache (validated profiles with 15-minute TTL)
// ---------------------------------------------------------------------------

export interface MerchantProfile {
  address: string
  name: string
  complianceStatus: "approved" | "blocked" | "pending"
  validatedAt: number
  apiKeyRotationAt?: number
}

export const MERCHANT_PROFILE_CACHE_KEY_PREFIX = "merchant:profile:"
export const MERCHANT_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Build the cache key for a merchant profile.
 * @param merchantAddress - The merchant's Soroban wallet address
 */
function getMerchantProfileCacheKey(merchantAddress: string): string {
  return `${MERCHANT_PROFILE_CACHE_KEY_PREFIX}${merchantAddress}`
}

/**
 * Retrieve a cached merchant profile if it exists and hasn't expired.
 * @param merchantAddress - The merchant's Soroban wallet address
 * @returns The cached profile, or null if not cached or expired
 */
export function getMerchantProfileCache(merchantAddress: string): MerchantProfile | null {
  const key = getMerchantProfileCacheKey(merchantAddress)
  return memoryCacheGet<MerchantProfile>(key)
}

/**
 * Cache a validated merchant profile for 15 minutes.
 * @param profile - The merchant profile to cache
 */
export function setMerchantProfileCache(profile: MerchantProfile): void {
  const key = getMerchantProfileCacheKey(profile.address)
  memoryCacheSet(key, profile, MERCHANT_PROFILE_CACHE_TTL_MS)
}

/**
 * Invalidate a cached merchant profile.
 *
 * Call this when:
 * - Compliance status changes (merchant is blocked/approved)
 * - API keys are rotated
 * - Merchant details are updated
 *
 * @param merchantAddress - The merchant's Soroban wallet address
 * @param reason - Optional reason for invalidation (logged for debugging)
 * @returns true if a cached entry was evicted, false otherwise
 */
export function invalidateMerchantProfileCache(merchantAddress: string, reason?: string): boolean {
  const key = getMerchantProfileCacheKey(merchantAddress)
  return invalidateCacheKey(key, reason)
}

/**
 * Clear all cached merchant profiles.
 * Used during shutdown or cache reset operations.
 */
export function clearAllMerchantProfileCaches(): void {
  const prefix = MERCHANT_PROFILE_CACHE_KEY_PREFIX
  for (const [key] of _memoryCache) {
    if (key.startsWith(prefix)) {
      _memoryCache.delete(key)
    }
  }
  logger.info({ prefix }, "All merchant profile caches cleared")
}
