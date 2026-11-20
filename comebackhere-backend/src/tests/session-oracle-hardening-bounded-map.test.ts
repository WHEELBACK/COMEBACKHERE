import { describe, it, expect } from "vitest"
import { pruneExpiring } from "../lib/bounded-map.js"

describe("pruneExpiring", () => {
  it("does nothing under the cap", () => {
    const m = new Map([["a", { expiresAt: 1 }]])
    pruneExpiring(m, 5, 100)
    expect(m.size).toBe(1)
  })
  it("drops expired entries first", () => {
    const m = new Map([["old", { expiresAt: 1 }], ["a", { expiresAt: 999 }], ["b", { expiresAt: 999 }]])
    pruneExpiring(m, 2, 100)
    expect([...m.keys()]).toEqual(["a", "b"])
  })
  it("evicts oldest-inserted when still over the cap", () => {
    const m = new Map([["a", { expiresAt: 999 }], ["b", { expiresAt: 999 }], ["c", { expiresAt: 999 }]])
    pruneExpiring(m, 2, 100)
    expect([...m.keys()]).toEqual(["b", "c"])
  })
})
