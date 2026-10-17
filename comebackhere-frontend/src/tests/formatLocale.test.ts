import { describe, it, expect, vi, afterEach } from "vitest"
import { formatAmount, USDC_DECIMALS } from "../utils/format"

describe("formatAmount locale", () => {
  afterEach(() => vi.restoreAllMocks())

  it("defaults to en-US regardless of the browser locale", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE")
    expect(formatAmount(12_345_670_000n, USDC_DECIMALS, "USDC")).toBe("1,234.567 USDC")
  })

  it("uses an explicitly requested locale", () => {
    expect(formatAmount(12_345_670_000n, USDC_DECIMALS, undefined, { locale: "de-DE" })).toBe("1.234,567")
  })
})
