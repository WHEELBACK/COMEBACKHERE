import { describe, it, expect, vi } from "vitest"
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
  it("evicts all excess entries when far over the cap", () => {
    const m = new Map<string, { expiresAt: number }>()
    for (let i = 0; i < 10; i++) {
      m.set(`k${i}`, { expiresAt: 999 })
    }
    pruneExpiring(m, 3, 100)
    expect(m.size).toBe(3)
    expect([...m.keys()]).toEqual(["k7", "k8", "k9"])
  })
  it("handles an empty map without throwing", () => {
    const m = new Map<string, { expiresAt: number }>()
    expect(() => pruneExpiring(m, 5, 100)).not.toThrow()
    expect(m.size).toBe(0)
  })
  it("handles a zero cap by clearing all entries", () => {
    const m = new Map([["a", { expiresAt: 999 }], ["b", { expiresAt: 999 }]])
    pruneExpiring(m, 0, 100)
    expect(m.size).toBe(0)
  })
  it("drops expired entries even when under the cap", () => {
    const m = new Map([["old", { expiresAt: 1 }], ["a", { expiresAt: 999 }]])
    pruneExpiring(m, 5, 100)
    expect([...m.keys()]).toEqual(["a"])
  })
  it("keeps entries whose expiry equals now", () => {
    const m = new Map([["edge", { expiresAt: 100 }], ["a", { expiresAt: 999 }]])
    pruneExpiring(m, 5, 100)
    expect([...m.keys()]).toEqual(["edge", "a"])
  })
  it("bounds memory under sustained peak load", () => {
    const cap = 50
    const m = new Map<string, { expiresAt: number }>()
    for (let i = 0; i < 1000; i++) {
      m.set(`k${i}`, { expiresAt: 999 })
      pruneExpiring(m, cap, 100)
      expect(m.size).toBeLessThanOrEqual(cap)
    }
    expect(m.size).toBe(cap)
    expect([...m.keys()]).toEqual(
      Array.from({ length: cap }, (_, i) => `k${1000 - cap + i}`),
    )
  })
  it("is invoked on each cache write to enforce the cap", () => {
    const spy = vi.fn(pruneExpiring)
    const cap = 2
    const m = new Map<string, { expiresAt: number }>()
    for (const key of ["a", "b", "c"]) {
      m.set(key, { expiresAt: 999 })
      spy(m, cap, 100)
    }
    expect(spy).toHaveBeenCalledTimes(3)
    expect(m.size).toBe(cap)
    expect([...m.keys()]).toEqual(["b", "c"])
  })
})