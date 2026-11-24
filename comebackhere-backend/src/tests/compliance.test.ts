/**
 * Integration tests for the compliance allow/block endpoints (#211).
 *
 * Covers:
 *  - POST /compliance/allow  — success, invalid address, missing address,
 *    401 when admin key is wrong, 503 when env is missing
 *  - POST /compliance/block  — success, invalid address, missing address,
 *    401 when admin key is wrong, 503 when env is missing
 *  - callComplianceOp unit tests — allow, block, simulation error,
 *    send error, confirmation timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { nativeToScVal, SorobanRpc, SorobanDataBuilder, xdr } from "stellar-sdk"
import request from "supertest"
import { createApp } from "../app.js"
import { callComplianceOp } from "../routes/compliance.js"
import { ComplianceIndexer } from "../services/complianceIndexer.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ADDRESS = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const SIGNER_SECRET = "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ"
const COMPLIANCE_CONTRACT = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const ADMIN_KEY = "test-admin-secret"
const NETWORK = "Standalone Network ; February 2025"

const ENV = {
  SOROBAN_RPC_URL: "http://localhost:8000",
  COMPLIANCE_CONTRACT_ID: COMPLIANCE_CONTRACT,
  SIGNER_SECRET_KEY: SIGNER_SECRET,
  NETWORK_PASSPHRASE: NETWORK,
  ADMIN_KEY,
}

// Pre-parsed simulation success result accepted by assembleTransaction
const PARSED_SIM_SUCCESS = {
  _parsed: true,
  latestLedger: 1,
  events: [],
  minResourceFee: "0",
  transactionData: new SorobanDataBuilder(),
  result: { auth: [], retval: xdr.ScVal.scvVoid() },
}

const fakeAccount = {
  accountId: () => VALID_ADDRESS,
  sequenceNumber: () => "100",
  incrementSequenceNumber: vi.fn(),
}

// ---------------------------------------------------------------------------
// Helper: build a minimal mock Soroban client for compliance.ts
// ---------------------------------------------------------------------------

type ComplianceMockClient = {
  getAccount: ReturnType<typeof vi.fn>
  simulateTransaction: ReturnType<typeof vi.fn>
  sendTransaction: ReturnType<typeof vi.fn>
  getTransaction: ReturnType<typeof vi.fn>
}

function makeMockClient(overrides: Partial<ComplianceMockClient> = {}): ComplianceMockClient {
  return {
    getAccount: vi.fn().mockResolvedValue(fakeAccount),
    simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "compliance-hash" }),
    getTransaction: vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Unit tests: callComplianceOp
// ---------------------------------------------------------------------------

describe("callComplianceOp", () => {
  it("returns Allowed status and hash when allow_address succeeds", async () => {
    const client = makeMockClient()
    const args = [nativeToScVal(VALID_ADDRESS, { type: "address" })]

    const result = await callComplianceOp(
      "allow_address",
      args,
      client as any,
      COMPLIANCE_CONTRACT,
      SIGNER_SECRET,
      NETWORK,
    )

    expect(result.status).toBe("Allowed")
    expect(result.hash).toBe("compliance-hash")
  })

  it("returns Blocked status and hash when block_address succeeds", async () => {
    const client = makeMockClient()
    const args = [nativeToScVal(VALID_ADDRESS, { type: "address" })]

    const result = await callComplianceOp(
      "block_address",
      args,
      client as any,
      COMPLIANCE_CONTRACT,
      SIGNER_SECRET,
      NETWORK,
    )

    expect(result.status).toBe("Blocked")
    expect(result.hash).toBe("compliance-hash")
  })

  it("returns AllowedUntil status for allow_address_until", async () => {
    const client = makeMockClient()
    const until = Math.floor(Date.now() / 1000) + 86_400
    const args = [
      nativeToScVal(VALID_ADDRESS, { type: "address" }),
      nativeToScVal(until, { type: "u64" }),
    ]

    const result = await callComplianceOp(
      "allow_address_until",
      args,
      client as any,
      COMPLIANCE_CONTRACT,
      SIGNER_SECRET,
      NETWORK,
    )

    expect(result.status).toBe("AllowedUntil")
  })

  it("throws 422 when simulation reports an error", async () => {
    const client = makeMockClient({
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: contract panic",
        latestLedger: 1,
      }),
    })
    const args = [nativeToScVal(VALID_ADDRESS, { type: "address" })]

    await expect(
      callComplianceOp(
        "allow_address",
        args,
        client as any,
        COMPLIANCE_CONTRACT,
        SIGNER_SECRET,
        NETWORK,
      ),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/simulation failed/i) })
  })

  it("throws 422 when sendTransaction returns ERROR", async () => {
    const client = makeMockClient({
      sendTransaction: vi.fn().mockResolvedValue({
        status: "ERROR",
        hash: "err-hash",
        errorResult: { toXDR: () => "err-xdr" },
      }),
    })
    const args = [nativeToScVal(VALID_ADDRESS, { type: "address" })]

    await expect(
      callComplianceOp(
        "block_address",
        args,
        client as any,
        COMPLIANCE_CONTRACT,
        SIGNER_SECRET,
        NETWORK,
      ),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/submission failed/i) })
  })

  it("throws 504 when transaction confirmation times out", async () => {
    const client = makeMockClient({
      getTransaction: vi.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }),
    })
    const args = [nativeToScVal(VALID_ADDRESS, { type: "address" })]

    await expect(
      callComplianceOp(
        "allow_address",
        args,
        client as any,
        COMPLIANCE_CONTRACT,
        SIGNER_SECRET,
        NETWORK,
      ),
    ).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/timeout/i) })
  }, 15_000)
})

// ---------------------------------------------------------------------------
// HTTP-layer tests: POST /compliance/allow
// ---------------------------------------------------------------------------

describe("POST /compliance/allow", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {}
    for (const key of Object.keys(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = ENV[key as keyof typeof ENV]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it("401 when x-admin-key header is missing", async () => {
    const res = await request(app)
      .post("/compliance/allow")
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toMatch(/unauthorized/i)
  })

  it("401 when x-admin-key header is wrong", async () => {
    const res = await request(app)
      .post("/compliance/allow")
      .set("x-admin-key", "wrong-key")
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(401)
  })

  it("400 when address is missing", async () => {
    const res = await request(app)
      .post("/compliance/allow")
      .set("x-admin-key", ADMIN_KEY)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/address/)
  })

  it("400 when address is not a valid Stellar public key", async () => {
    const res = await request(app)
      .post("/compliance/allow")
      .set("x-admin-key", ADMIN_KEY)
      .send({ address: "NOT_A_STELLAR_KEY" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/address/)
  })

  it("400 when until is provided but is not a positive integer", async () => {
    const res = await request(app)
      .post("/compliance/allow")
      .set("x-admin-key", ADMIN_KEY)
      .send({ address: VALID_ADDRESS, until: -1 })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/until/)
  })

  it("503 when required env vars are missing", async () => {
    delete process.env.COMPLIANCE_CONTRACT_ID
    const res = await request(app)
      .post("/compliance/allow")
      .set("x-admin-key", ADMIN_KEY)
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(503)
    expect(res.body.error.message).toMatch(/misconfiguration/i)
  })
})

// ---------------------------------------------------------------------------
// HTTP-layer tests: POST /compliance/block
// ---------------------------------------------------------------------------

describe("POST /compliance/block", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {}
    for (const key of Object.keys(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = ENV[key as keyof typeof ENV]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it("401 when x-admin-key header is missing", async () => {
    const res = await request(app)
      .post("/compliance/block")
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toMatch(/unauthorized/i)
  })

  it("401 when x-admin-key header is wrong", async () => {
    const res = await request(app)
      .post("/compliance/block")
      .set("x-admin-key", "bad-key")
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(401)
  })

  it("400 when address is missing", async () => {
    const res = await request(app)
      .post("/compliance/block")
      .set("x-admin-key", ADMIN_KEY)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/address/)
  })

  it("400 when address has invalid format (e.g. G... but not a real key)", async () => {
    const res = await request(app)
      .post("/compliance/block")
      .set("x-admin-key", ADMIN_KEY)
      .send({ address: "GNOTAVALIDADDRESSATALL" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/address/)
  })

  it("503 when required env vars are missing", async () => {
    delete process.env.SOROBAN_RPC_URL
    const res = await request(app)
      .post("/compliance/block")
      .set("x-admin-key", ADMIN_KEY)
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(503)
    expect(res.body.error.message).toMatch(/misconfiguration/i)
  })
})

// ---------------------------------------------------------------------------
// Unit tests: ComplianceIndexer batching, memory bounds, error handling
// ---------------------------------------------------------------------------

type IndexerEvent = { ledger: number; address: string; kind: "allow" | "block" }

function makeEvent(ledger: number, i = 0): IndexerEvent {
  return {
    ledger,
    address: VALID_ADDRESS,
    kind: i % 2 === 0 ? "allow" : "block",
  }
}

function makeIndexer(overrides: Record<string, unknown> = {}) {
  const fetchEvents = vi.fn().mockResolvedValue([])
  const onBatch = vi.fn().mockResolvedValue(undefined)
  const indexer = new ComplianceIndexer({
    batchSize: 50,
    maxBufferSize: 200,
    fetchEvents,
    onBatch,
    ...overrides,
  } as any)
  return { indexer, fetchEvents, onBatch }
}

describe("ComplianceIndexer — batching", () => {
  it("emits events in batches of the configured batchSize", async () => {
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 50,
      maxBufferSize: 500,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    expect(onBatch).toHaveBeenCalledTimes(3)
    expect(onBatch.mock.calls[0][0]).toHaveLength(50)
    expect(onBatch.mock.calls[1][0]).toHaveLength(50)
    expect(onBatch.mock.calls[2][0]).toHaveLength(20)
  })

  it("does not emit a batch when there are no events", async () => {
    const { indexer, onBatch } = makeIndexer()
    await indexer.runOnce()
    expect(onBatch).not.toHaveBeenCalled()
  })

  it("emits a single partial batch when events < batchSize", async () => {
    const events = Array.from({ length: 7 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 50,
      maxBufferSize: 500,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    expect(onBatch).toHaveBeenCalledTimes(1)
    expect(onBatch.mock.calls[0][0]).toHaveLength(7)
  })

  it("preserves event ordering across batches", async () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 3,
      maxBufferSize: 500,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    const flattened = onBatch.mock.calls.flatMap((c: any[]) => c[0])
    expect(flattened.map((e: IndexerEvent) => e.ledger)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })
})

describe("ComplianceIndexer — memory bounds", () => {
  it("never buffers more than maxBufferSize events", async () => {
    const events = Array.from({ length: 1000 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 25,
      maxBufferSize: 100,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    expect(indexer.bufferSize).toBeLessThanOrEqual(100)
    for (const call of onBatch.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(25)
    }
  })

  it("drains the buffer to zero after a successful run", async () => {
    const events = Array.from({ length: 80 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 20,
      maxBufferSize: 100,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    expect(indexer.bufferSize).toBe(0)
  })

  it("rejects invalid configuration with a defensive error", () => {
    expect(
      () =>
        new ComplianceIndexer({
          batchSize: 0,
          maxBufferSize: 100,
          fetchEvents: vi.fn(),
          onBatch: vi.fn(),
        } as any),
    ).toThrow(/batchSize/i)

    expect(
      () =>
        new ComplianceIndexer({
          batchSize: 10,
          maxBufferSize: 5,
          fetchEvents: vi.fn(),
          onBatch: vi.fn(),
        } as any),
    ).toThrow(/maxBufferSize/i)
  })
})

describe("ComplianceIndexer — error handling under load", () => {
  it("propagates fetch errors without corrupting buffer state", async () => {
    const fetchEvents = vi.fn().mockRejectedValue(new Error("rpc down"))
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 10,
      maxBufferSize: 100,
      fetchEvents,
      onBatch,
    } as any)

    await expect(indexer.runOnce()).rejects.toThrow(/rpc down/i)
    expect(indexer.bufferSize).toBe(0)
    expect(onBatch).not.toHaveBeenCalled()
  })

  it("stops emitting further batches when onBatch fails", async () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("sink failed"))
    const indexer = new ComplianceIndexer({
      batchSize: 10,
      maxBufferSize: 200,
      fetchEvents,
      onBatch,
    } as any)

    await expect(indexer.runOnce()).rejects.toThrow(/sink failed/i)
    expect(onBatch).toHaveBeenCalledTimes(2)
  })

  it("handles high-volume bursts without exceeding memory bounds", async () => {
    const events = Array.from({ length: 5000 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 100,
      maxBufferSize: 250,
      fetchEvents,
      onBatch,
    } as any)

    await indexer.runOnce()

    expect(indexer.bufferSize).toBeLessThanOrEqual(250)
    const totalEmitted = onBatch.mock.calls.reduce(
      (sum: number, c: any[]) => sum + c[0].length,
      0,
    )
    expect(totalEmitted).toBe(5000)
  })

  it("is safe to invoke runOnce concurrently without double-emitting", async () => {
    const events = Array.from({ length: 60 }, (_, i) => makeEvent(1, i))
    const fetchEvents = vi.fn().mockResolvedValue(events)
    const onBatch = vi.fn().mockResolvedValue(undefined)
    const indexer = new ComplianceIndexer({
      batchSize: 20,
      maxBufferSize: 200,
      fetchEvents,
      onBatch,
    } as any)

    await Promise.all([indexer.runOnce(), indexer.runOnce()])

    const totalEmitted = onBatch.mock.calls.reduce(
      (sum: number, c: any[]) => sum + c[0].length,
      0,
    )
    expect(totalEmitted).toBe(60)
  })
})
