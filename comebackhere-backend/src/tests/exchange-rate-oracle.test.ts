import { describe, it, expect } from "vitest"
import { ExchangeRateOracle, validateAssetCode, validateRateValue } from "../lib/exchange-rate-oracle.js"

describe("exchange-rate-oracle", () => {
  it("validates asset codes and rejects malformed or injected inputs", () => {
    expect(validateAssetCode("USDC")).toBe("USDC")
    expect(validateAssetCode("XLM")).toBe("XLM")
    expect(() => validateAssetCode("usdc")).toThrow("Invalid asset code")
    expect(() => validateAssetCode("USDC; DROP")).toThrow("Invalid asset code")
    expect(() => validateAssetCode("")).toThrow("Invalid asset code")
  })

  it("validates finite positive exchange rates within bounds", () => {
    expect(validateRateValue(1.25)).toBe(1.25)
    expect(() => validateRateValue(0)).toThrow("Invalid exchange rate value")
    expect(() => validateRateValue(-5)).toThrow("Invalid exchange rate value")
    expect(() => validateRateValue(Number.NaN)).toThrow("Invalid exchange rate value")
    expect(() => validateRateValue(Number.POSITIVE_INFINITY)).toThrow("Invalid exchange rate value")
  })

  it("stores quotes, converts amounts accurately, and evicts stale quotes", () => {
    const oracle = new ExchangeRateOracle({ maxEntries: 3, ttlMs: 1_000 })
    oracle.setRate("XLM", "USDC", 0.12, 100)

    const quote = oracle.getRate("XLM", "USDC", 500)
    expect(quote?.rate).toBe(0.12)
    expect(oracle.convert(100, "XLM", "USDC", 500)).toBe(12)

    // Expired at t = 1100
    expect(oracle.getRate("XLM", "USDC", 1_100)).toBeNull()
    expect(() => oracle.convert(100, "XLM", "USDC", 1_100)).toThrow("Stale or missing exchange rate")
  })

  it("bounds memory growth under high load via pruneExpiring eviction", () => {
    const oracle = new ExchangeRateOracle({ maxEntries: 2, ttlMs: 5_000 })
    oracle.setRate("XLM", "USDC", 0.1, 100)
    oracle.setRate("BTC", "USDC", 60_000, 200)
    oracle.setRate("ETH", "USDC", 3_000, 300)

    expect(oracle.size()).toBeLessThanOrEqual(2)
    expect(oracle.getRate("XLM", "USDC", 350)).toBeNull()
    expect(oracle.getRate("BTC", "USDC", 350)?.rate).toBe(60_000)
    expect(oracle.getRate("ETH", "USDC", 350)?.rate).toBe(3_000)
  })
})
