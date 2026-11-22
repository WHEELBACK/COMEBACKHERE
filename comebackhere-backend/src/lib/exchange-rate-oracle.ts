import { pruneExpiring } from "./bounded-map.js"

const ASSET_CODE_RE = /^[A-Z0-9]{1,12}$/
const MAX_RATE_SCALE = 1_000_000_000_000

export interface ExchangeRateQuote {
  baseAsset: string
  quoteAsset: string
  rate: number
  updatedAt: number
  expiresAt: number
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

export function validateAssetCode(value: unknown, label = "asset code"): string {
  if (typeof value !== "string" || !ASSET_CODE_RE.test(value)) {
    badRequest(`Invalid ${label}`)
  }
  return value
}

export function validateRateValue(rate: unknown): number {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE_SCALE) {
    badRequest("Invalid exchange rate value")
  }
  return rate
}

export class ExchangeRateOracle {
  private readonly cache = new Map<string, ExchangeRateQuote>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(options?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = options?.maxEntries ?? 256
    this.ttlMs = options?.ttlMs ?? 60_000
  }

  private pairKey(baseAsset: string, quoteAsset: string): string {
    return `${baseAsset}/${quoteAsset}`
  }

  setRate(base: unknown, quote: unknown, rate: unknown, now = Date.now()): ExchangeRateQuote {
    const baseAsset = validateAssetCode(base, "base asset")
    const quoteAsset = validateAssetCode(quote, "quote asset")
    const validRate = validateRateValue(rate)

    if (!Number.isFinite(now) || now <= 0) {
      badRequest("Invalid timestamp")
    }

    pruneExpiring(this.cache, this.maxEntries - 1, now)
    const entry: ExchangeRateQuote = {
      baseAsset,
      quoteAsset,
      rate: validRate,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.cache.set(this.pairKey(baseAsset, quoteAsset), entry)
    return entry
  }

  getRate(base: unknown, quote: unknown, now = Date.now()): ExchangeRateQuote | null {
    const baseAsset = validateAssetCode(base, "base asset")
    const quoteAsset = validateAssetCode(quote, "quote asset")
    if (baseAsset === quoteAsset) {
      return {
        baseAsset,
        quoteAsset,
        rate: 1,
        updatedAt: now,
        expiresAt: now + this.ttlMs,
      }
    }
    const key = this.pairKey(baseAsset, quoteAsset)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now) {
      this.cache.delete(key)
      return null
    }
    return entry
  }

  convert(amount: unknown, base: unknown, quote: unknown, now = Date.now()): number {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      badRequest("Invalid conversion amount")
    }
    const quoteEntry = this.getRate(base, quote, now)
    if (!quoteEntry) {
      throw Object.assign(new Error("Stale or missing exchange rate"), { status: 503 })
    }
    return Math.round(amount * quoteEntry.rate * 1e7) / 1e7
  }

  size(): number {
    return this.cache.size
  }
}
