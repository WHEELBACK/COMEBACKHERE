import { describe, it, expect } from "vitest"
import { buildAuditFilter, exceedsAuditSkip, MAX_AUDIT_SKIP } from "../lib/audit-filter.js"

describe("buildAuditFilter", () => {
  it("builds a filter from valid primitives", () => {
    expect(buildAuditFilter({ address: "GABC", event_type: "address_blocked", from_ledger: 1, to_ledger: 5 })).toEqual({
      address: "GABC",
      event_type: "address_blocked",
      ledger: { $gte: 1, $lte: 5 },
    })
  })

  it("drops operator objects and unknown event types", () => {
    const filter = buildAuditFilter({ address: { $ne: "x" }, event_type: "bogus", from_ledger: { $gt: 0 } })
    expect(filter).toEqual({})
  })

  it("ignores non-finite ledger bounds", () => {
    expect(buildAuditFilter({ from_ledger: Number.NaN, to_ledger: Infinity })).toEqual({})
  })
})

describe("exceedsAuditSkip", () => {
  it("allows skips up to the maximum", () => {
    expect(exceedsAuditSkip(0)).toBe(false)
    expect(exceedsAuditSkip(MAX_AUDIT_SKIP)).toBe(false)
  })

  it("rejects deeper or invalid skips", () => {
    expect(exceedsAuditSkip(MAX_AUDIT_SKIP + 1)).toBe(true)
    expect(exceedsAuditSkip(Number.NaN)).toBe(true)
  })
})
