import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useNetwork, networkName, getExpectedNetworkPassphrase } from "../hooks/useNetwork"

const EXPECTED = getExpectedNetworkPassphrase()
const MAINNET = "Public Global Stellar Network ; September 2015"

describe("useNetwork", () => {
  it("reads the expected network from VITE_NETWORK_PASSPHRASE", () => {
    expect(EXPECTED).toBe(import.meta.env.VITE_NETWORK_PASSPHRASE)
    expect(EXPECTED).not.toBe("")
  })

  it("reports no mismatch when the wallet is on the expected network", () => {
    const { result } = renderHook(() =>
      useNetwork({ walletPassphrase: EXPECTED, connected: true })
    )
    expect(result.current.hasNetworkMismatch).toBe(false)
  })

  it("reports a mismatch when the wallet is on a different network", () => {
    const { result } = renderHook(() =>
      useNetwork({ walletPassphrase: MAINNET, connected: true })
    )
    expect(result.current.hasNetworkMismatch).toBe(true)
    expect(result.current.walletNetwork).toBe("mainnet")
  })

  it("does not report a mismatch while disconnected or when the wallet network is unknown", () => {
    const disconnected = renderHook(() =>
      useNetwork({ walletPassphrase: MAINNET, connected: false })
    )
    expect(disconnected.result.current.hasNetworkMismatch).toBe(false)

    const unknown = renderHook(() => useNetwork({ walletPassphrase: null, connected: true }))
    expect(unknown.result.current.hasNetworkMismatch).toBe(false)
  })

  it("flags isCheckingWallet while connecting", () => {
    const { result } = renderHook(() =>
      useNetwork({ walletPassphrase: null, connected: false, connecting: true })
    )
    expect(result.current.isCheckingWallet).toBe(true)
  })
})

describe("networkName", () => {
  it("maps known passphrases to short names", () => {
    expect(networkName("Test SDF Network ; September 2015")).toBe("testnet")
    expect(networkName(MAINNET)).toBe("mainnet")
  })

  it("falls back to the raw passphrase for unknown networks", () => {
    expect(networkName("Custom ; 2024")).toBe("Custom ; 2024")
    expect(networkName(null)).toBeNull()
  })
})
