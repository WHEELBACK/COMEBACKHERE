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
import { processComplianceEvents } from "../services/complianceIndexer.js"

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
// Unit tests: processComplianceEvents (indexer hardening, #1067 / #1068)
// ---------------------------------------------------------------------------

type IndexerEvent = {
  ledger: number
  txHash: string
  topic: xdr.ScVal[]
  value: xdr.ScVal
}

function makeEvent(overrides: Partial<IndexerEvent> = {}): IndexerEvent {
  return {
    ledger: 100,
    txHash: "tx-hash-1",
    topic: [
      nativeToScVal("allow_address", { type: "symbol" }),
      nativeToScVal(VALID_ADDRESS, { type: "address" }),
    ],
    value: nativeToScVal(VALID_ADDRESS, { type: "address" }),
    ...overrides,
  }
}

describe("processComplianceEvents", () => {
  it("returns an empty result and preserves the cursor for an empty batch", async () => {
    const result = await processComplianceEvents([], "cursor-0")

    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(result.cursor).toBe("cursor-0")
  })

  it("processes a well-formed batch and advances the cursor", async () => {
    const events = [makeEvent({ ledger: 100 }), makeEvent({ ledger: 101, txHash: "tx-hash-2" })]

    const result = await processComplianceEvents(events, "cursor-0")

    expect(result.processed).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(result.cursor).toBe("101")
  })

  it("skips malformed events without throwing and still advances the cursor", async () => {
    const events = [
      makeEvent({ ledger: 100 }),
      // Missing topic entirely
      { ledger: 101, txHash: "bad-1", topic: [], value: xdr.ScVal.scvVoid() } as IndexerEvent,
      // Non-symbol topic
      makeEvent({
        ledger: 102,
        txHash: "bad-2",
        topic: [nativeToScVal(42, { type: "u32" })],
      }),
      // Null-ish value
      { ledger: 103, txHash: "bad-3", topic: makeEvent().topic, value: null as any },
    ]

    const result = await processComplianceEvents(events, "cursor-0")

    expect(result.processed).toBe(1)
    expect(result.skipped).toBe(3)
    expect(result.errors).toHaveLength(3)
    for (const err of result.errors) {
      expect(err).toMatchObject({ ledger: expect.any(Number) })
    }
    // Cursor must still advance past skipped events so they are not re-fetched forever.
    expect(result.cursor).toBe("103")
  })

  it("degrades gracefully when the RPC fetch throws", async () => {
    const fetchEvents = vi.fn().mockRejectedValue(new Error("RPC unavailable"))

    const result = await processComplianceEvents([], "cursor-0", { fetchEvents })

    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/RPC unavailable/)
    // Cursor must not advance on a transport failure so the batch is retried.
    expect(result.cursor).toBe("cursor-0")
  })

  it("does not advance the cursor when every event in the batch is malformed", async () => {
    const events = [
      { ledger: 200, txHash: "bad-a", topic: [], value: xdr.ScVal.scvVoid() } as IndexerEvent,
      { ledger: 201, txHash: "bad-b", topic: [], value: xdr.ScVal.scvVoid() } as IndexerEvent,
    ]

    const result = await processComplianceEvents(events, "cursor-0")

    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(result.cursor).toBe("cursor-0")
  })

  it("reports a consistent error shape for every failure", async () => {
    const events = [
      { ledger: 300, txHash: "bad-c", topic: [], value: xdr.ScVal.scvVoid() } as IndexerEvent,
    ]

    const result = await processComplianceEvents(events, "cursor-0")

    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        ledger: 300,
        txHash: "bad-c",
        message: expect.any(String),
      }),
    )
  })
})
