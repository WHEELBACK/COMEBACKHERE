import { describe, it, expect } from "vitest"
import {
  TaxCalculator,
  validateJurisdiction,
  validateMerchantActor,
  validateTaxRateBps,
  validateTaxableAmount,
} from "../lib/tax-calculator.js"

describe("tax-calculator", () => {
  it("enforces merchant actor authentication and rejects injection payloads", () => {
    expect(validateMerchantActor("merchant_01")).toBe("merchant_01")
    expect(() => validateMerchantActor("")).toThrow("Unauthorized or invalid merchant actor")
    expect(() => validateMerchantActor("merchant; DROP TABLE")).toThrow(
      "Unauthorized or invalid merchant actor",
    )
    expect(() => validateMerchantActor({ $ne: null })).toThrow(
      "Unauthorized or invalid merchant actor",
    )
  })

  it("validates jurisdiction codes, basis points, and taxable amount boundaries", () => {
    expect(validateJurisdiction("US-CA")).toBe("US-CA")
    expect(validateJurisdiction("NG")).toBe("NG")
    expect(() => validateJurisdiction("us-ca")).toThrow("Invalid tax jurisdiction code")
    expect(() => validateJurisdiction("US; --")).toThrow("Invalid tax jurisdiction code")

    expect(validateTaxRateBps(750)).toBe(750)
    expect(() => validateTaxRateBps(-1)).toThrow("Invalid tax rate basis points")
    expect(() => validateTaxRateBps(10_001)).toThrow("Invalid tax rate basis points")

    expect(validateTaxableAmount(250.5)).toBe(250.5)
    expect(() => validateTaxableAmount(-10)).toThrow("Invalid taxable amount")
    expect(() => validateTaxableAmount(Number.NaN)).toThrow("Invalid taxable amount")
  })

  it("computes tax accurately and evicts expired or excess rules", () => {
    const calc = new TaxCalculator({ maxRules: 2, ttlMs: 1_000 })
    calc.setRule("merchant_1", "US-NY", 800, 100)

    const res = calc.calculate("merchant_1", "US-NY", 200, 500)
    expect(res.taxAmount).toBe(16)
    expect(res.total).toBe(216)

    // Rule expires at t = 1100
    const expiredRes = calc.calculate("merchant_1", "US-NY", 200, 1_200)
    expect(expiredRes.taxAmount).toBe(0)
    expect(expiredRes.total).toBe(200)

    // Bounded capacity under peak rule insertions
    calc.setRule("merchant_1", "US-CA", 725, 2_000)
    calc.setRule("merchant_1", "US-TX", 625, 2_100)
    calc.setRule("merchant_1", "GB", 2_000, 2_200)
    expect(calc.size()).toBeLessThanOrEqual(2)
  })
})
