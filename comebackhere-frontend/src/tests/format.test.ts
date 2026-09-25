import { describe, it, expect } from "vitest"
import {
  formatAmount,
  compareRawAmounts,
  toRawBigInt,
  INVALID_AMOUNT,
  STELLAR_DECIMALS,
} from "../utils/format"

describe("formatAmount", () => {
  describe("zero", () => {
    it("formats zero with two fraction digits", () => {
      expect(formatAmount(0n, 7, "USDC")).toBe("0.00 USDC")
      expect(formatAmount("0", 7)).toBe("0.00")
      // A token with no decimals has no fraction to show
      expect(formatAmount(0, 0)).toBe("0")
    })

    it("never renders negative zero after rounding", () => {
      expect(formatAmount(-1n, 7, "XLM", { maximumFractionDigits: 2 })).toBe("0.00 XLM")
    })
  })

  describe("amounts smaller than one unit", () => {
    it("shows the smallest unit at full precision", () => {
      expect(formatAmount(1n, 7, "XLM")).toBe("0.0000001 XLM")
    })

    it("shows fractional amounts without trailing zeros beyond the minimum", () => {
      expect(formatAmount(5_000_000n, 7, "USDC")).toBe("0.50 USDC")
      expect(formatAmount(1_234_567n, 7)).toBe("0.1234567")
    })

    it("rounds sub-unit amounts to the requested precision", () => {
      expect(formatAmount(49_999n, 7, undefined, { maximumFractionDigits: 2 })).toBe("0.00")
      expect(formatAmount(50_000n, 7, undefined, { maximumFractionDigits: 2 })).toBe("0.01")
    })
  })

  describe("rounding", () => {
    it("rounds half away from zero", () => {
      expect(formatAmount(12_345_000n, 7, undefined, { maximumFractionDigits: 2 })).toBe("1.23")
      expect(formatAmount(12_350_000n, 7, undefined, { maximumFractionDigits: 2 })).toBe("1.24")
      expect(formatAmount(-12_350_000n, 7, undefined, { maximumFractionDigits: 2 })).toBe("-1.24")
    })

    it("carries rounding into the integer part", () => {
      expect(formatAmount(99_999_999n, 7, undefined, { maximumFractionDigits: 2 })).toBe("10.00")
      expect(formatAmount(9_999_999_999_950n, 7, undefined, { maximumFractionDigits: 4 })).toBe(
        "1,000,000.00"
      )
    })

    it("can drop fractions entirely", () => {
      expect(
        formatAmount(15_000_000n, 7, undefined, { maximumFractionDigits: 0, minimumFractionDigits: 0 })
      ).toBe("2")
    })
  })

  describe("very large values", () => {
    it("keeps full precision beyond Number.MAX_SAFE_INTEGER", () => {
      // i128 max: far beyond what a JS number can represent exactly
      const i128Max = "170141183460469231731687303715884105727"
      expect(formatAmount(i128Max, 7, "USDC")).toBe(
        "17,014,118,346,046,923,173,168,730,371,588.4105727 USDC"
      )
    })

    it("formats a large bigint with grouping and exact digits", () => {
      expect(formatAmount(123_456_789_012_345_678_901n, 7, "XLM")).toBe(
        "12,345,678,901,234.5678901 XLM"
      )
    })

    it("gives identical results for bigint and string input", () => {
      const raw = 9_007_199_254_740_993n // MAX_SAFE_INTEGER + 2
      expect(formatAmount(raw, 7)).toBe(formatAmount(raw.toString(), 7))
      expect(formatAmount(raw, 7)).toBe("900,719,925.4740993")
    })
  })

  describe("decimal counts", () => {
    it("handles 0 decimals", () => {
      expect(formatAmount(1234n, 0, "PTS")).toBe("1,234 PTS")
    })

    it("handles 2, 6, 7 and 18 decimals", () => {
      expect(formatAmount(12345n, 2)).toBe("123.45")
      expect(formatAmount(1_500_000n, 6, "USDC")).toBe("1.50 USDC")
      expect(formatAmount(1_500_000n, 7, "USDC")).toBe("0.15 USDC")
      expect(formatAmount(10n ** 18n + 1n, 18, "ETH")).toBe("1.000000000000000001 ETH")
    })

    it("defaults to Stellar's 7 decimals", () => {
      expect(STELLAR_DECIMALS).toBe(7)
      expect(formatAmount(10_000_000n)).toBe("1.00")
    })

    it("rejects invalid decimal counts", () => {
      expect(() => formatAmount(1n, -1)).toThrow(RangeError)
      expect(() => formatAmount(1n, 1.5)).toThrow(RangeError)
    })
  })

  describe("input handling", () => {
    it("accepts safe integer numbers and trims strings", () => {
      expect(formatAmount(10_500_000, 7, "USDC")).toBe("1.05 USDC")
      expect(formatAmount(" 10500000 ", 7, "USDC")).toBe("1.05 USDC")
    })

    it("renders a placeholder for malformed or imprecise input", () => {
      expect(formatAmount("1.5", 7)).toBe(INVALID_AMOUNT)
      expect(formatAmount("abc", 7)).toBe(INVALID_AMOUNT)
      expect(formatAmount("", 7)).toBe(INVALID_AMOUNT)
      expect(formatAmount(2 ** 60, 7)).toBe(INVALID_AMOUNT)
      expect(formatAmount(0.5, 7)).toBe(INVALID_AMOUNT)
    })

    it("uses locale grouping and decimal separators", () => {
      expect(formatAmount(12_345_678_900n, 7, "EURC", { locale: "de-DE" })).toBe("1.234,56789 EURC")
    })
  })
})

describe("compareRawAmounts", () => {
  it("compares exactly beyond the safe integer range", () => {
    expect(compareRawAmounts("9007199254740993", "9007199254740992")).toBe(1)
    expect(compareRawAmounts(5n, "5")).toBe(0)
    expect(compareRawAmounts("500", 1000)).toBe(-1)
  })
})

describe("toRawBigInt", () => {
  it("throws on non-integer input", () => {
    expect(() => toRawBigInt("1e7")).toThrow(RangeError)
  })
})
