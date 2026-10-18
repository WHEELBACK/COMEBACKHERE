import { renderHook, act, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useWallet, walletNotReadyReason, type WalletState } from "../hooks/useWallet"

// Matches VITE_NETWORK_PASSPHRASE in vite.config.ts
const EXPECTED_NETWORK = "Test SDF Future Network ; September 2025"
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015"
const ADDRESS = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Freighter stub whose initial (mount) check reports "not connected yet". */
function stubFreighter(overrides: Record<string, unknown> = {}) {
  const api = {
    getAddress: vi.fn().mockResolvedValue({ address: "" }),
    getNetworkDetails: vi.fn().mockResolvedValue({ passphrase: EXPECTED_NETWORK }),
    ...overrides,
  }
  vi.stubGlobal("freighterApi", api)
  return api
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("useWallet", () => {
  it("starts disconnected with no error", () => {
    const { result } = renderHook(() => useWallet())
    expect(result.current.connected).toBe(false)
    expect(result.current.address).toBeNull()
    expect(result.current.connecting).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.isLocked).toBe(false)
  })

  it("detects when wallet is not installed", () => {
    // Don't stub freighterApi, simulate not installed
    const { result } = renderHook(() => useWallet())
    expect(result.current.isNotInstalled).toBe(true)
    expect(result.current.connected).toBe(false)
  })

  it("connects and sets address", async () => {
    const fakeAddress = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    vi.stubGlobal("freighterApi", {
      getAddress: vi.fn().mockResolvedValue({ address: fakeAddress }),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.connected).toBe(true)
    expect(result.current.address).toBe(fakeAddress)
    expect(result.current.connecting).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.isLocked).toBe(false)
  })

  it("detects locked wallet with user rejected error", async () => {
    vi.stubGlobal("freighterApi", {
      getAddress: vi
        .fn()
        .mockRejectedValue(new Error("User rejected")),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      try {
        await result.current.connect()
      } catch {
        // Expected to throw
      }
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.isLocked).toBe(true)
    expect(result.current.error).toContain("User rejected")
  })

  it("detects locked wallet with locked error", async () => {
    vi.stubGlobal("freighterApi", {
      getAddress: vi.fn().mockRejectedValue(new Error("Wallet is locked")),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      try {
        await result.current.connect()
      } catch {
        // Expected to throw
      }
    })

    expect(result.current.isLocked).toBe(true)
  })

  it("detects locked wallet with unauthorized error", async () => {
    vi.stubGlobal("freighterApi", {
      getAddress: vi
        .fn()
        .mockRejectedValue(new Error("Unauthorized")),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      try {
        await result.current.connect()
      } catch {
        // Expected to throw
      }
    })

    expect(result.current.isLocked).toBe(true)
  })

  it("handles generic connection errors", async () => {
    vi.stubGlobal("freighterApi", {
      getAddress: vi
        .fn()
        .mockRejectedValue(new Error("Generic error")),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      try {
        await result.current.connect()
      } catch {
        // Expected to throw
      }
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.isLocked).toBe(false)
    expect(result.current.error).toContain("Generic error")
  })

  it("disconnect clears all wallet state fields", async () => {
    const fakeAddress = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    vi.stubGlobal("freighterApi", {
      getAddress: vi.fn().mockResolvedValue({ address: fakeAddress }),
    })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.connected).toBe(true)

    act(() => {
      result.current.disconnect()
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.address).toBeNull()
    expect(result.current.connecting).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.isLocked).toBe(false)
  })

  it("provides retryConnect function", async () => {
    const fakeAddress = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    const connectFn = vi.fn()
    
    vi.stubGlobal("freighterApi", {
      getAddress: connectFn,
    })

    // First attempt fails with User rejected
    connectFn.mockRejectedValueOnce(new Error("User rejected"))

    const { result } = renderHook(() => useWallet())

    // Wait for initial check to complete
    await act(async () => {
      // No-op to let effect run
    })

    // Verify locked state from initial check
    expect(result.current.isLocked).toBe(true)

    // Set up success response for retry
    connectFn.mockResolvedValueOnce({ address: fakeAddress })

    // Retry succeeds
    await act(async () => {
      await result.current.retryConnect()
    })
    expect(result.current.connected).toBe(true)
    expect(result.current.address).toBe(fakeAddress)
  })

  it("refreshes the active address and network while connected", async () => {
    vi.useFakeTimers()
    const firstAddress = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    const secondAddress = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    const getAddress = vi.fn().mockResolvedValueOnce({ address: firstAddress }).mockResolvedValue({ address: secondAddress })
    const getNetworkDetails = vi.fn()
      .mockResolvedValueOnce({ passphrase: "Test SDF Network ; September 2015" })
      .mockResolvedValue({ passphrase: "Public Global Stellar Network ; September 2015" })
    vi.stubGlobal("freighterApi", { getAddress, getNetworkDetails })

    const { result } = renderHook(() => useWallet())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.address).toBe(firstAddress)
    expect(result.current.network).toBe("Test SDF Network ; September 2015")

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.address).toBe(secondAddress)
    expect(result.current.network).toBe("Public Global Stellar Network ; September 2015")
    vi.useRealTimers()
  })
})

describe("useWallet — explicit state union", () => {
  it("is not-installed when Freighter is missing", () => {
    const { result } = renderHook(() => useWallet())
    expect(result.current.wallet).toEqual({ status: "not-installed" })
    expect(result.current.ready).toBe(false)
  })

  it("is disconnected when Freighter has not shared an address", async () => {
    stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.wallet).toEqual({ status: "disconnected", error: null })
    expect(result.current.connected).toBe(false)
  })

  it("is connecting while the request is pending", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()

    const pending = deferred<{ address: string }>()
    api.getAddress.mockReturnValueOnce(pending.promise)
    let connectPromise!: Promise<WalletState>
    act(() => {
      connectPromise = result.current.connect()
    })
    expect(result.current.status).toBe("connecting")
    expect(result.current.connecting).toBe(true)
    expect(result.current.ready).toBe(false)

    await act(async () => {
      pending.resolve({ address: ADDRESS })
      await connectPromise
    })
    expect(result.current.status).toBe("connected")
  })

  it("is connected on the expected network", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    api.getAddress.mockResolvedValue({ address: ADDRESS })
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.wallet).toEqual({ status: "connected", address: ADDRESS, network: EXPECTED_NETWORK })
    expect(result.current.ready).toBe(true)
    expect(result.current.notReadyReason).toBeNull()
  })

  it("is wrong-network when Freighter is on another network", async () => {
    stubFreighter({
      getAddress: vi.fn().mockResolvedValue({ address: ADDRESS }),
      getNetworkDetails: vi.fn().mockResolvedValue({ passphrase: OTHER_NETWORK }),
    })
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.wallet).toEqual({
      status: "wrong-network",
      address: ADDRESS,
      network: OTHER_NETWORK,
      expectedNetwork: EXPECTED_NETWORK,
    })
    expect(result.current.connected).toBe(true)
    expect(result.current.address).toBe(ADDRESS)
    expect(result.current.ready).toBe(false)
    expect(result.current.notReadyReason).toMatch(/wrong network/)
  })

  it("treats an unknown network as connected", async () => {
    stubFreighter({
      getAddress: vi.fn().mockResolvedValue({ address: ADDRESS }),
      getNetworkDetails: vi.fn().mockRejectedValue(new Error("unsupported")),
    })
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.status).toBe("connected")
    expect(result.current.network).toBeNull()
  })

  it("is rejected when the user declines the request", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    api.getAddress.mockRejectedValue(new Error("User declined access"))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.wallet).toEqual({ status: "rejected", reason: "rejected", error: "User declined access" })
  })

  it("is rejected with a locked reason when the wallet is locked", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    api.getAddress.mockResolvedValue({ address: "", error: "Wallet is locked" })
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.wallet).toEqual({ status: "rejected", reason: "locked", error: "Wallet is locked" })
    expect(result.current.notReadyReason).toMatch(/locked/)
  })

  it("does not throw from connect; the error lives in state", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    api.getAddress.mockRejectedValue(new Error("Network timeout"))
    let final!: WalletState
    await act(async () => {
      final = await result.current.connect()
    })
    expect(final).toEqual({ status: "disconnected", error: "Network timeout" })
  })
})

describe("useWallet — transitions", () => {
  it("disconnected → connecting → rejected → connecting → connected", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    const seen: string[] = [result.current.status]

    const first = deferred<{ address: string }>()
    api.getAddress.mockReturnValueOnce(first.promise)
    let p!: Promise<WalletState>
    act(() => {
      p = result.current.connect()
    })
    seen.push(result.current.status)
    await act(async () => {
      first.reject(new Error("User rejected"))
      await p
    })
    seen.push(result.current.status)

    const second = deferred<{ address: string }>()
    api.getAddress.mockReturnValueOnce(second.promise)
    act(() => {
      p = result.current.retryConnect()
    })
    seen.push(result.current.status)
    await act(async () => {
      second.resolve({ address: ADDRESS })
      await p
    })
    seen.push(result.current.status)

    expect(seen).toEqual(["disconnected", "connecting", "rejected", "connecting", "connected"])
  })

  it("connecting → wrong-network when approved on another network", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    api.getAddress.mockResolvedValue({ address: ADDRESS })
    api.getNetworkDetails.mockResolvedValue({ passphrase: OTHER_NETWORK })
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.status).toBe("wrong-network")
  })

  it("connected ⇄ wrong-network as the user switches networks", async () => {
    vi.useFakeTimers()
    const api = stubFreighter({ getAddress: vi.fn().mockResolvedValue({ address: ADDRESS }) })
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.status).toBe("connected")

    api.getNetworkDetails.mockResolvedValue({ passphrase: OTHER_NETWORK })
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await flush()
    expect(result.current.status).toBe("wrong-network")

    api.getNetworkDetails.mockResolvedValue({ passphrase: EXPECTED_NETWORK })
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await flush()
    expect(result.current.status).toBe("connected")
  })

  it("rejected → connected when the user unlocks and the poll sees the account", async () => {
    vi.useFakeTimers()
    const api = stubFreighter({ getAddress: vi.fn().mockRejectedValue(new Error("Wallet is locked")) })
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.status).toBe("rejected")

    api.getAddress.mockResolvedValue({ address: ADDRESS })
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await flush()
    expect(result.current.status).toBe("connected")
  })

  it("not-installed → disconnected once the extension appears", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWallet())
    expect(result.current.status).toBe("not-installed")

    stubFreighter()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await flush()
    expect(result.current.status).toBe("disconnected")
  })

  it("connected → disconnected on disconnect, and polling does not reconnect", async () => {
    vi.useFakeTimers()
    stubFreighter({ getAddress: vi.fn().mockResolvedValue({ address: ADDRESS }) })
    const { result } = renderHook(() => useWallet())
    await flush()
    expect(result.current.status).toBe("connected")

    act(() => result.current.disconnect())
    expect(result.current.wallet).toEqual({ status: "disconnected", error: null })

    await act(async () => {
      vi.advanceTimersByTime(15000)
    })
    await flush()
    expect(result.current.status).toBe("disconnected")
  })

  it("a disconnect during connecting wins over the late connect result", async () => {
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    const pending = deferred<{ address: string }>()
    api.getAddress.mockReturnValueOnce(pending.promise)
    let p!: Promise<WalletState>
    act(() => {
      p = result.current.connect()
    })
    act(() => result.current.disconnect())
    await act(async () => {
      pending.resolve({ address: ADDRESS })
      await p
    })
    expect(result.current.status).toBe("disconnected")
  })

  it("polling does not interrupt an in-flight connect", async () => {
    vi.useFakeTimers()
    const api = stubFreighter()
    const { result } = renderHook(() => useWallet())
    await flush()
    const pending = deferred<{ address: string }>()
    api.getAddress.mockReturnValueOnce(pending.promise)
    act(() => {
      void result.current.connect()
    })
    const callsBefore = api.getAddress.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(api.getAddress).toHaveBeenCalledTimes(callsBefore)
    expect(result.current.status).toBe("connecting")
  })
})

describe("useWallet — shared state", () => {
  it("every hook instance sees the same wallet state", async () => {
    const api = stubFreighter()
    const header = renderHook(() => useWallet())
    const tab = renderHook(() => useWallet())
    await flush()

    api.getAddress.mockResolvedValue({ address: ADDRESS })
    await act(async () => {
      await header.result.current.connect()
    })
    expect(tab.result.current.status).toBe("connected")
    expect(tab.result.current.address).toBe(ADDRESS)

    act(() => tab.result.current.disconnect())
    await waitFor(() => expect(header.result.current.status).toBe("disconnected"))
  })
})

describe("walletNotReadyReason", () => {
  it("explains every non-ready state and is null when connected", () => {
    const states: WalletState[] = [
      { status: "not-installed" },
      { status: "disconnected", error: null },
      { status: "connecting" },
      { status: "rejected", reason: "rejected", error: "x" },
      { status: "rejected", reason: "locked", error: "x" },
      { status: "wrong-network", address: ADDRESS, network: OTHER_NETWORK, expectedNetwork: EXPECTED_NETWORK },
    ]
    const reasons = states.map(walletNotReadyReason)
    reasons.forEach((reason) => expect(reason).toEqual(expect.any(String)))
    expect(new Set(reasons).size).toBe(reasons.length)
    expect(walletNotReadyReason({ status: "connected", address: ADDRESS, network: EXPECTED_NETWORK })).toBeNull()
  })
})
