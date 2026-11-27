import { describe, it, expect } from "vitest"
import { truncateAddress } from "../utils/truncateAddress"

describe("truncateAddress", () => {
  const LONG_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA"

  it("truncates long addresses with default head and tail", () => {
    const result = truncateAddress(LONG_ADDRESS)
    expect(result).toBe("GAAZI4TC...VKOCCWNA")
    expect(result).toContain("...")
  })

  it("respects custom head and tail lengths", () => {
    const result = truncateAddress(LONG_ADDRESS, 4, 4)
    expect(result).toBe("GAAZ...CWNA")
  })

  it("returns the full address when it fits within head + tail + 3", () => {
    const short = "GAAZ"
    expect(truncateAddress(short, 4, 4)).toBe("GAAZ")
  })

  it("handles exactly head + tail + 3 chars without truncation", () => {
    const address = "12345678901234567890" // 20 chars
    expect(truncateAddress(address, 8, 9)).toBe(address)
  })
})
