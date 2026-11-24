import { describe, it, expect } from "vitest"
import { limitFractionDigits } from "../utils/amountInput"

describe("limitFractionDigits", () => {
  it("truncates excess fractional digits", () => {
    expect(limitFractionDigits("1.123456789", 7)).toBe("1.1234567")
  })
  it("leaves valid input untouched", () => {
    expect(limitFractionDigits("25.50", 7)).toBe("25.50")
    expect(limitFractionDigits("25", 7)).toBe("25")
    expect(limitFractionDigits("25.", 7)).toBe("25.")
  })
})
