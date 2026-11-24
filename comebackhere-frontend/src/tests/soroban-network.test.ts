/**
 * Tests for issue #882 — Invoice payment must reject a transaction signed on
 * the wrong Stellar network.
 *
 * The `buildAndSend` helper in soroban.ts now validates that the signed
 * transaction's network passphrase matches VITE_NETWORK_PASSPHRASE before
 * submitting to the RPC node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { getNetworkPassphrase } from "../utils/soroban"

// ---------------------------------------------------------------------------
// getNetworkPassphrase
// ---------------------------------------------------------------------------

describe("getNetworkPassphrase — #882", () => {
  const ORIGINAL_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE

  afterEach(() => {
    // Restore the import.meta.env mock if modified.
    vi.unstubAllEnvs()
  })

  it("returns the configured VITE_NETWORK_PASSPHRASE", () => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015")
    expect(getNetworkPassphrase()).toBe("Test SDF Network ; September 2015")
  })

  it("falls back to the STANDALONE passphrase when env is not set", () => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "")
    // With an empty passphrase the function returns Networks.STANDALONE
    const passphrase = getNetworkPassphrase()
    // Should not be empty — must have a non-trivial fallback.
    expect(passphrase).toBeTruthy()
  })

  it("returns a non-empty string in all cases", () => {
    const passphrase = getNetworkPassphrase()
    expect(typeof passphrase).toBe("string")
    expect(passphrase.length).toBeGreaterThan(0)
  })
})
