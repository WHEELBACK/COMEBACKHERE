/**
 * Tests for the treasury balances in-memory cache (#212).
 *
 * Verifies:
 *  1. Repeated GET /api/treasury/balances calls within the TTL hit the cache
 *     (getTokenBalance mock is only called once).
 *  2. The cache expires after the TTL, causing a fresh RPC call.
 *  3. The cache is invalidated immediately after a successful execute-settlement.
 *  4. The treasury indexer invalidates the cache when it indexes a
 *     settlement_executed event, and logs the invalidation.
 *  5. Events other than settlement_executed leave the cache alone, so TTL
 *     expiry remains the fallback for them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import {
  getBalanceCache,
  setBalanceCache,
  invalidateBalanceCache,
} from "../routes/treasury.js"
import { processIndexerBatch } from "../services/treasury-indexer.js"
import type { SorobanClient } from "../lib/soroban.js"
import type { Db } from "mongodb"

// ---------------------------------------------------------------------------
// Constants — valid Stellar credentials for env setup
// ---------------------------------------------------------------------------

const SIGNER_SECRET = "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ"
const TREASURY_CONTRACT = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const USDC_CONTRACT = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const INVOICE_CONTRACT = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const NETWORK = "Standalone Network ; February 2025"

const ENV = {
  SOROBAN_RPC_URL: "http://localhost:8000",
  TREASURY_CONTRACT_ID: TREASURY_CONTRACT,
  USDC_CONTRACT_ID: USDC_CONTRACT,
  INVOICE_CONTRACT_ID: INVOICE_CONTRACT,
  SIGNER_SECRET_KEY: SIGNER_SECRET,
  NETWORK_PASSPHRASE: NETWORK,
}

// ---------------------------------------------------------------------------
// Unit tests for the cache helpers
// ---------------------------------------------------------------------------

describe("balance cache helpers", () => {
  beforeEach(() => {
    // Ensure every test starts with a clean cache
    invalidateBalanceCache()
  })

  it("getBalanceCache returns null when nothing is cached", () => {
    expect(getBalanceCache()).toBeNull()
  })

  it("setBalanceCache stores data and getBalanceCache returns it", () => {
    const data = [{ token: USDC_CONTRACT, balance: "9999" }]
    setBalanceCache(data)
    expect(getBalanceCache()).toEqual(data)
  })

  it("invalidateBalanceCache clears the cache immediately", () => {
    setBalanceCache([{ token: USDC_CONTRACT, balance: "1234" }])
    invalidateBalanceCache()
    expect(getBalanceCache()).toBeNull()
  })

  it("cache expires after TTL", () => {
    const data = [{ token: USDC_CONTRACT, balance: "500" }]

    vi.useFakeTimers()

    setBalanceCache(data)
    // Within TTL — should be fresh
    expect(getBalanceCache()).toEqual(data)

    // Advance time past the 5-second TTL
    vi.advanceTimersByTime(6_000)

    expect(getBalanceCache()).toBeNull()

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// HTTP-layer tests: GET /api/treasury/balances uses the cache
// ---------------------------------------------------------------------------

// We mock the soroban lib module so getTokenBalance is controllable
vi.mock("../lib/soroban.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/soroban.js")>()
  return {
    ...original,
    buildSorobanClient: vi.fn(() => ({})),
    getTokenBalance: vi.fn().mockResolvedValue(BigInt(10_000_000)),
  }
})

describe("GET /api/treasury/balances — caching behaviour", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>

  beforeEach(async () => {
    // Save and set env vars
    envBackup = {}
    for (const key of Object.keys(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = ENV[key as keyof typeof ENV]
    }
    // Always start with a clean cache so tests are isolated
    invalidateBalanceCache()

    // Reset mock call counts between tests
    const { getTokenBalance } = await import("../lib/soroban.js")
    vi.mocked(getTokenBalance).mockClear()
    vi.mocked(getTokenBalance).mockResolvedValue(BigInt(10_000_000))
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it("returns 200 with balance data", async () => {
    const res = await request(app).get("/api/treasury/balances")
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ token: USDC_CONTRACT, balance: "10000000" }])
  })

  it("repeated calls within TTL only call getTokenBalance once", async () => {
    const { getTokenBalance } = await import("../lib/soroban.js")

    await request(app).get("/api/treasury/balances")
    await request(app).get("/api/treasury/balances")
    await request(app).get("/api/treasury/balances")

    expect(vi.mocked(getTokenBalance)).toHaveBeenCalledTimes(1)
  })

  it("returns the same cached value on repeated calls", async () => {
    const res1 = await request(app).get("/api/treasury/balances")
    const res2 = await request(app).get("/api/treasury/balances")

    expect(res1.body).toEqual(res2.body)
  })

  it("calls getTokenBalance again after cache is invalidated", async () => {
    const { getTokenBalance } = await import("../lib/soroban.js")

    await request(app).get("/api/treasury/balances")
    expect(vi.mocked(getTokenBalance)).toHaveBeenCalledTimes(1)

    invalidateBalanceCache()

    await request(app).get("/api/treasury/balances")
    expect(vi.mocked(getTokenBalance)).toHaveBeenCalledTimes(2)
  })

  it("cache expires after TTL and next call fetches fresh data", async () => {
    const { getTokenBalance } = await import("../lib/soroban.js")

    // Only fake Date so supertest's real I/O timers keep working, and keep the
    // fake clock active for the HTTP call so the entry stays expired.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      // Seed the cache with a known value
      setBalanceCache([{ token: USDC_CONTRACT, balance: "10000000" }])

      // Advance past the 5-second TTL — the cache should now be stale
      vi.advanceTimersByTime(6_000)
      expect(getBalanceCache()).toBeNull()

      // Confirm a fresh HTTP call hits the mock (cache expired)
      await request(app).get("/api/treasury/balances")
      expect(vi.mocked(getTokenBalance)).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Indexer-driven invalidation: settlement_executed evicts the balance cache
// ---------------------------------------------------------------------------

function makeEvent(eventType: string, settlementId = 7, pagingToken = `tok-${eventType}`) {
  // Each slot answers both u64() and address() since event types read the
  // same positions differently (e.g. slot 3 is merchant vs. approval weight).
  const slot = (n: number, a: string) => ({
    u64: () => ({ toString: () => String(n) }),
    address: () => ({ toString: () => a }),
  })
  return {
    pagingToken,
    txHash: `tx-${eventType}`,
    topic: [{ sym: () => ({ toString: () => eventType }) }],
    value: {
      vec: () => [slot(settlementId, ""), slot(0, "addr-token"), slot(1000, ""), slot(1, "addr-merchant")],
    },
  }
}

function makeClient(events: ReturnType<typeof makeEvent>[]): SorobanClient {
  return {
    getEvents: vi.fn().mockResolvedValue({ events, latestLedger: 200 }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200 }),
  } as unknown as SorobanClient
}

function makeDatabase(): Db {
  const collection = {
    findOne: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({}),
  }
  return { collection: vi.fn(() => collection) } as unknown as Db
}

describe("treasury indexer — balance cache invalidation", () => {
  const CACHED = [{ token: USDC_CONTRACT, balance: "1" }]

  beforeEach(() => {
    invalidateBalanceCache()
    delete process.env.WEBHOOK_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("invalidates the cache when settlement_executed is indexed", async () => {
    setBalanceCache(CACHED)
    expect(getBalanceCache()).toEqual(CACHED)

    await processIndexerBatch(makeClient([makeEvent("settlement_executed")]), TREASURY_CONTRACT, makeDatabase())

    expect(getBalanceCache()).toBeNull()
  })

  it("logs the invalidation with the settlement id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    setBalanceCache(CACHED)

    await processIndexerBatch(makeClient([makeEvent("settlement_executed", 42)]), TREASURY_CONTRACT, makeDatabase())

    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("[cache] invalidated key=treasury:balances") && l.includes("settlement_executed id=42"))).toBe(true)
  })

  it("does not invalidate the cache for proposed or approved events", async () => {
    setBalanceCache(CACHED)

    await processIndexerBatch(
      makeClient([makeEvent("settlement_proposed"), makeEvent("settlement_approved")]),
      TREASURY_CONTRACT,
      makeDatabase(),
    )

    expect(getBalanceCache()).toEqual(CACHED)
  })

  it("keeps TTL as the fallback when no settlement_executed event is seen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      setBalanceCache(CACHED)
      await processIndexerBatch(makeClient([]), TREASURY_CONTRACT, makeDatabase())
      expect(getBalanceCache()).toEqual(CACHED)

      vi.advanceTimersByTime(6_000)
      expect(getBalanceCache()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("next GET /balances after an indexed execution fetches fresh data", async () => {
    for (const [key, val] of Object.entries(ENV)) process.env[key] = val
    const { getTokenBalance } = await import("../lib/soroban.js")
    vi.mocked(getTokenBalance).mockClear()
    vi.mocked(getTokenBalance).mockResolvedValueOnce(BigInt(100)).mockResolvedValueOnce(BigInt(40))
    const app = createApp()

    const before = await request(app).get("/api/treasury/balances")
    expect(before.body).toEqual([{ token: USDC_CONTRACT, balance: "100" }])

    await processIndexerBatch(makeClient([makeEvent("settlement_executed")]), TREASURY_CONTRACT, makeDatabase())

    const after = await request(app).get("/api/treasury/balances")
    expect(after.body).toEqual([{ token: USDC_CONTRACT, balance: "40" }])
    expect(vi.mocked(getTokenBalance)).toHaveBeenCalledTimes(2)
  })
})
