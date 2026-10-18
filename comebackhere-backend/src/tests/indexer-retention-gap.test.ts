/**
 * Tests for RPC event-retention gap handling in the invoice indexer.
 *
 * Verifies:
 *  1. Retention errors from getEvents are recognised (lib/soroban.ts).
 *  2. The missing range is logged, counted in metrics and stored in Mongo.
 *  3. The indexer continues from the oldest retained ledger afterwards.
 *  4. Unrelated RPC errors are rethrown, not treated as gaps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { xdr } from "stellar-sdk"
import { pollOnce, loadMongoCursor, MONGO_CURSOR_ID, type IndexerRpc } from "../indexer.js"
import { ledgerFromPagingToken, parseRetentionError } from "../lib/soroban.js"
import { _resetMetrics, renderMetrics } from "../lib/metrics.js"
import { createApp } from "../app.js"
import { FakeDb } from "./helpers/fake-mongo.js"

const CONTRACT_ID = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const RETENTION_MESSAGE =
  "startLedger must be between the oldest ledger: 5000 and the latest ledger: 9000 for this rpc instance."

function makeEvent(ledger: number, index = 1) {
  return {
    id: `evt-${ledger}-${index}`,
    pagingToken: `${(BigInt(ledger) << 32n).toString()}-${String(index).padStart(10, "0")}`,
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    txHash: `tx-${ledger}`,
    topic: [xdr.ScVal.scvSymbol("invoice_paid"), xdr.ScVal.scvU64(new xdr.Uint64(1n))],
    value: xdr.ScVal.scvVoid(),
  }
}

/** RPC mock that rejects any request below its oldest retained ledger. */
function makeRetentionRpc(oldest: number, events: ReturnType<typeof makeEvent>[], error: unknown = { code: -32600, message: RETENTION_MESSAGE }) {
  const rpc: IndexerRpc = {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 9000 }),
    getHealth: vi.fn().mockResolvedValue({ status: "healthy", oldestLedger: oldest }),
    getEvents: vi.fn(async (params: any) => {
      const from = params.cursor ? ledgerFromPagingToken(params.cursor)! : params.startLedger
      if (from < oldest) throw error
      return { latestLedger: 9000, events: events.filter((e) => e.ledger >= from) }
    }),
  }
  return rpc
}

describe("parseRetentionError", () => {
  it("reads the oldest and latest ledger from the RPC error", () => {
    expect(parseRetentionError({ code: -32600, message: RETENTION_MESSAGE })).toEqual({
      oldestLedger: 5000,
      latestLedger: 9000,
    })
    expect(parseRetentionError(new Error(RETENTION_MESSAGE))?.oldestLedger).toBe(5000)
  })

  it("returns null for unrelated errors", () => {
    expect(parseRetentionError(new Error("ECONNREFUSED"))).toBeNull()
    expect(parseRetentionError(undefined)).toBeNull()
  })

  it("decodes the ledger from a paging token", () => {
    expect(ledgerFromPagingToken(`${(4321n << 32n).toString()}-0000000001`)).toBe(4321)
    expect(ledgerFromPagingToken("not-a-token")).toBeNull()
  })
})

describe("indexer retention gap handling", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetMetrics()
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it("records the gap and resumes from the oldest retained ledger", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 3000 })
    const rpc = makeRetentionRpc(5000, [makeEvent(5000), makeEvent(5001)])

    const applied = await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(applied).toBe(2)
    expect(rpc.getEvents).toHaveBeenLastCalledWith(expect.objectContaining({ startLedger: 5000 }))

    const gaps = db.collection("indexer_gaps").docs
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      _id: "invoice:3000-4999",
      from_ledger: 3000,
      to_ledger: 4999,
      missing_ledgers: 2000,
      status: "open",
      contract_id: CONTRACT_ID,
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("RETENTION GAP: ledgers 3000-4999"))

    const metrics = renderMetrics()
    expect(metrics).toContain('indexer_retention_gaps_total{indexer="invoice"} 1')
    expect(metrics).toContain('indexer_retention_gap_ledgers_total{indexer="invoice"} 2000')
    expect(metrics).toContain('indexer_retention_gap_last_missing_ledgers{indexer="invoice"} 2000')

    expect(await loadMongoCursor(db as any)).toMatchObject({ last_ledger: 5001 })
  })

  it("derives the gap start from a stale paging token", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({
      _id: MONGO_CURSOR_ID,
      paging_token: makeEvent(4200).pagingToken,
      last_ledger: 4200,
    })
    const rpc = makeRetentionRpc(5000, [makeEvent(5000)])

    await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(db.collection("indexer_gaps").docs[0]).toMatchObject({ from_ledger: 4200, to_ledger: 4999 })
  })

  it("falls back to getHealth when the error does not include the oldest ledger", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 100 })
    const rpc = makeRetentionRpc(5000, [], new Error("start ledger is before the oldest ledger"))

    await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(rpc.getHealth).toHaveBeenCalled()
    expect(db.collection("indexer_gaps").docs[0]).toMatchObject({ from_ledger: 100, to_ledger: 4999 })
  })

  it("does not record the same gap twice", async () => {
    const db = new FakeDb()
    const cursors = db.collection("indexer_cursors")
    cursors.docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 3000 })
    const rpc = makeRetentionRpc(5000, [])

    await pollOnce(rpc, CONTRACT_ID, db as any)
    cursors.docs[0].last_ledger = 3000 // e.g. the cursor save was lost in a crash
    await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(db.collection("indexer_gaps").docs).toHaveLength(1)
  })

  it("rethrows RPC errors that are not retention errors", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 3000 })
    const rpc = makeRetentionRpc(5000, [], new Error("ECONNREFUSED"))

    await expect(pollOnce(rpc, CONTRACT_ID, db as any)).rejects.toThrow("ECONNREFUSED")
    expect(db.collection("indexer_gaps").docs).toHaveLength(0)
    expect(await loadMongoCursor(db as any)).toMatchObject({ last_ledger: 3000 })
  })

  it("exposes the gap metrics on GET /metrics", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 4990 })
    await pollOnce(makeRetentionRpc(5000, []), CONTRACT_ID, db as any)

    const res = await request(createApp()).get("/metrics")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/plain/)
    expect(res.text).toContain('indexer_retention_gap_ledgers_total{indexer="invoice"} 10')
  })
})
