/**
 * Evicts expired entries first, then oldest-inserted entries, until size <= max.
 */
export function pruneExpiring<V extends { expiresAt: number }>(map: Map<string, V>, max: number, now = Date.now()): void {
  if (map.size <= max) return
  for (const [k, v] of map) {
    if (v.expiresAt <= now) map.delete(k)
  }
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

export type EvictionPolicy = 'lru' | 'fifo'

export interface BoundedMapOptions {
  /** Maximum number of entries retained. Must be a positive integer. */
  max: number
  /** Eviction policy. Defaults to 'lru'. */
  policy?: EvictionPolicy
  /** Optional default TTL in milliseconds applied to entries inserted via `set` without an explicit TTL. */
  defaultTtlMs?: number
  /** Optional clock injection for deterministic testing. */
  now?: () => number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

/**
 * A size-limited Map with optional TTL-based expiration and an eviction policy
 * ('lru' or 'fifo'). Designed for bounded in-memory caches (e.g. reporting-engine
 * aggregation/result caches) to keep memory usage predictable under peak load.
 *
 * - Expired entries are lazily purged on access and eagerly on `prune()`/`set()`.
 * - When the map exceeds `max`, expired entries are evicted first, then entries
 *   are evicted according to the configured policy until size <= max.
 * - All operations are defensive: invalid options throw, and no-ops are safe.
 */
export class BoundedMap<K, V> {
  private readonly store = new Map<K, Entry<V>>()
  private readonly max: number
  private readonly policy: EvictionPolicy
  private readonly defaultTtlMs: number | undefined
  private readonly now: () => number

  constructor(options: BoundedMapOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('BoundedMap: options object is required')
    }
    const { max } = options
    if (!Number.isInteger(max) || max <= 0) {
      throw new RangeError('BoundedMap: max must be a positive integer')
    }
    const policy = options.policy ?? 'lru'
    if (policy !== 'lru' && policy !== 'fifo') {
      throw new RangeError(`BoundedMap: unsupported eviction policy "${String(policy)}"`)
    }
    if (options.defaultTtlMs !== undefined) {
      if (typeof options.defaultTtlMs !== 'number' || !Number.isFinite(options.defaultTtlMs) || options.defaultTtlMs < 0) {
        throw new RangeError('BoundedMap: defaultTtlMs must be a non-negative finite number')
      }
    }
    this.max = max
    this.policy = policy
    this.defaultTtlMs = options.defaultTtlMs
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.store.size
  }

  has(key: K): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return false
    }
    return true
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    if (this.policy === 'lru') {
      // Refresh recency by re-inserting at the tail.
      this.store.delete(key)
      this.store.set(key, entry)
    }
    return entry.value
  }

  /**
   * Inserts or updates an entry. `ttlMs` overrides the default TTL; a value of 0
   * or a non-positive TTL means the entry never expires.
   */
  set(key: K, value: V, ttlMs?: number): this {
    const ttl = ttlMs ?? this.defaultTtlMs
    let expiresAt = Number.POSITIVE_INFINITY
    if (ttl !== undefined && ttl > 0) {
      expiresAt = this.now() + ttl
    }
    // Delete first so re-insertion moves the key to the tail (recency order).
    this.store.delete(key)
    this.store.set(key, { value, expiresAt })
    this.evict()
    return this
  }

  delete(key: K): boolean {
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  keys(): IterableIterator<K> {
    return this.store.keys()
  }

  values(): IterableIterator<V> {
    const iter = this.store.values()
    return (function* () {
      for (const entry of iter) {
        yield entry.value
      }
    })()
  }

  entries(): IterableIterator<[K, V]> {
    const iter = this.store.entries()
    return (function* () {
      for (const [k, entry] of iter) {
        yield [k, entry.value] as [K, V]
      }
    })()
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  /** Removes all expired entries. Returns the number of entries removed. */
  prune(): number {
    const now = this.now()
    let removed = 0
    for (const [k, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(k)
        removed++
      }
    }
    return removed
  }

  private evict(): void {
    if (this.store.size <= this.max) return
    // Evict expired entries first.
    this.prune()
    // Then evict by policy until within bounds.
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next()
      if (oldest.done) break
      this.store.delete(oldest.value)
    }
  }
}