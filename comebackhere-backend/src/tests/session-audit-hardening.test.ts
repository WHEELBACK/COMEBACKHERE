import { describe, it, expect } from "vitest"
import { safeKeyEquals } from "../middleware/adminAuth.js"
import { isSafeRequestId } from "../middleware/correlationId.js"
import {
  assertNonEmptyAddress,
  complianceStatusForEvent,
  isValidAllowanceExpiry,
  tryParseEvent,
} from "../lib/compliance-guards.js"

describe("safeKeyEquals", () => {
  it("matches equal keys and rejects different ones, including different lengths", () => {
    expect(safeKeyEquals("secret", "secret")).toBe(true)
    expect(safeKeyEquals("secret", "secreT")).toBe(false)
    expect(safeKeyEquals("s", "secret")).toBe(false)
  })
})

describe("isSafeRequestId", () => {
  it("accepts typical trace ids", () => {
    expect(isSafeRequestId("abc-123_x.y:z")).toBe(true)
  })
  it("rejects control characters, spaces and oversized values", () => {
    expect(isSafeRequestId("bad id")).toBe(false)
    expect(isSafeRequestId("a\nb")).toBe(false)
    expect(isSafeRequestId("a".repeat(129))).toBe(false)
  })
})

describe("compliance guards", () => {
  it("validates allowance expiry", () => {
    expect(isValidAllowanceExpiry(1700000000)).toBe(true)
    expect(isValidAllowanceExpiry(0)).toBe(false)
    expect(isValidAllowanceExpiry(1.5)).toBe(false)
    expect(isValidAllowanceExpiry("5")).toBe(false)
  })
  it("rejects empty addresses", () => {
    expect(() => assertNonEmptyAddress("")).toThrow()
    expect(() => assertNonEmptyAddress("GABC")).not.toThrow()
  })
  it("maps event types to statuses and throws on unknown", () => {
    expect(complianceStatusForEvent("address_blocked")).toBe("Blocked")
    expect(() => complianceStatusForEvent("nope")).toThrow()
  })
  it("tryParseEvent returns null when the parser throws", () => {
    const ev = {} as never
    expect(tryParseEvent(ev, () => { throw new Error("bad") })).toBeNull()
    expect(tryParseEvent(ev, () => 7)).toBe(7)
  })
})
