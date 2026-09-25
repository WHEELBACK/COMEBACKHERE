import { renderHook, act, waitFor } from "@testing-library/react"
import { describe, it, expect, beforeEach } from "vitest"
import { useHashTab, parseTabHash, isTab, DEFAULT_TAB } from "../hooks/useHashTab"

function setHash(hash: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${hash}`)
}

beforeEach(() => {
  setHash("")
})

describe("parseTabHash", () => {
  it("parses known tabs with or without a leading slash", () => {
    expect(parseTabHash("#refund")).toBe("refund")
    expect(parseTabHash("#/treasury")).toBe("treasury")
    expect(parseTabHash("#batch-expire")).toBe("batch-expire")
  })

  it("falls back to payment for empty, unknown, or malformed hashes", () => {
    expect(parseTabHash("")).toBe("payment")
    expect(parseTabHash("#")).toBe("payment")
    expect(parseTabHash("#not-a-tab")).toBe("payment")
    expect(parseTabHash("#%E0%A4%A")).toBe("payment")
  })

  it("isTab narrows only known values", () => {
    expect(isTab("compliance")).toBe(true)
    expect(isTab("Compliance")).toBe(false)
  })
})

describe("useHashTab", () => {
  it("defaults to payment when there is no hash", () => {
    const { result } = renderHook(() => useHashTab())
    expect(result.current[0]).toBe(DEFAULT_TAB)
    expect(DEFAULT_TAB).toBe("payment")
  })

  it("reads the initial tab from the hash on load", () => {
    setHash("#refund")
    const { result } = renderHook(() => useHashTab())
    expect(result.current[0]).toBe("refund")
  })

  it("falls back to payment for an unknown hash on load", () => {
    setHash("#bogus")
    const { result } = renderHook(() => useHashTab())
    expect(result.current[0]).toBe("payment")
  })

  it("updates the hash when the tab changes", () => {
    const { result } = renderHook(() => useHashTab())
    act(() => result.current[1]("compliance"))
    expect(result.current[0]).toBe("compliance")
    expect(window.location.hash).toBe("#compliance")
  })

  it("pushes one history entry per distinct tab change", () => {
    const { result } = renderHook(() => useHashTab())
    const start = window.history.length
    act(() => result.current[1]("tokens"))
    act(() => result.current[1]("tokens"))
    expect(window.history.length).toBe(start + 1)
  })

  it("follows external hashchange events", () => {
    const { result } = renderHook(() => useHashTab())
    act(() => {
      setHash("#treasury")
      window.dispatchEvent(new HashChangeEvent("hashchange"))
    })
    expect(result.current[0]).toBe("treasury")
  })

  it("returns to the previous tab on browser back and forward", async () => {
    const { result } = renderHook(() => useHashTab())
    act(() => result.current[1]("refund"))
    act(() => result.current[1]("treasury"))
    expect(result.current[0]).toBe("treasury")

    act(() => window.history.back())
    await waitFor(() => expect(result.current[0]).toBe("refund"))

    act(() => window.history.forward())
    await waitFor(() => expect(result.current[0]).toBe("treasury"))
  })

  it("removes its hashchange listener on unmount", () => {
    const { result, unmount } = renderHook(() => useHashTab())
    unmount()
    setHash("#refund")
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    expect(result.current[0]).toBe("payment")
  })
})
