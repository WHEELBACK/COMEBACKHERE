/**
 * Tests for the Mongo-backed indexer cursor and per-event idempotency.
 *
 * Verifies:
 *  1. The cursor (paging token + last ledger) is saved to Mongo after a batch.
 *  2. A new indexer resumes from the saved cursor instead of a fixed ledger.
 *  3. A crash in the middle of a batch loses no events and duplicates none.
 *  4. Replaying events that were already applied is a no-op.
 */

import { describe, it, expect, vi } from "vitest"
import { xdr } from "stellar-sdk"
import { pollOnce, loadMongoCursor, MONGO_CURSOR_ID, type IndexerRpc } from "../indexer.js"
import { FakeDb } from "./helpers/fake-mongo.js"

const CONTRACT_ID = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"

function makeEvent(i: number, type = "invoice_paid") {
  const ledger = 1000 + Math.floor(i / 2)
  return {
    id: `evt-${String(i).padStart(4, "0")}`,
    pagingToken: `tok-${String(i).padStart(4, "0")}`,
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    txHash: `tx-${i}`,
    topic: [xdr.ScVal.scvSymbol(type), xdr.ScVal.scvU64(new xdr.Uint64(BigInt(i)))],
    value: xdr.ScVal.scvVoid(),
  }
}

/** Fake RPC serving a fixed event stream by cursor or start ledger. */
function makeRpc(events: ReturnType<typeof makeEvent>[], batchSize = 100) {
  const calls: any[] = []
  const rpc: IndexerRpc = {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
    getEvents: vi.fn(async (params: any) => {
      calls.push(params)
      let remaining = events
      if (params.cursor) {
        remaining = events.filter((e) => e.pagingToken > params.cursor)
      } else if (params.startLedger) {
        remaining = events.filter((e) => e.ledger >= params.startLedger)
      }
      return { latestLedger: 2000, events: remaining.slice(0, Math.min(batchSize, params.limit)) }
    }),
  }
  return { rpc, calls }
}

function seedInvoices(db: FakeDb, count: number) {
  const invoices = db.collection("invoices")
  for (let i = 0; i < count; i++) invoices.docs.push({ invoice_id: String(i), status: "Pending" })
}

describe("indexer Mongo cursor", () => {
  it("saves the last processed paging token and ledger after a batch", async () => {
    const db = new FakeDb()
    const { rpc } = makeRpc([makeEvent(0), makeEvent(1), makeEvent(2)])

    const applied = await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(applied).toBe(3)
    const cursor = await loadMongoCursor(db as any)
    expect(cursor).toMatchObject({ _id: MONGO_CURSOR_ID, paging_token: "tok-0002", last_ledger: 1001 })
  })

  it("resumes from the saved cursor on startup", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({
      _id: MONGO_CURSOR_ID,
      paging_token: "tok-0001",
      last_ledger: 1000,
    })
    const { rpc, calls } = makeRpc([makeEvent(0), makeEvent(1), makeEvent(2)])

    const applied = await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(calls[0]).toMatchObject({ cursor: "tok-0001" })
    expect(calls[0].startLedger).toBeUndefined()
    expect(applied).toBe(1)
    expect(db.collection("invoice_events").docs.map((d) => d.event_id)).toEqual(["evt-0002"])
  })

  it("resumes from last_ledger when no paging token is stored", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: null, last_ledger: 1001 })
    const { rpc, calls } = makeRpc([makeEvent(0), makeEvent(1), makeEvent(2)])

    await pollOnce(rpc, CONTRACT_ID, db as any)

    expect(calls[0]).toMatchObject({ startLedger: 1001 })
    expect(rpc.getLatestLedger).not.toHaveBeenCalled()
  })

  it("advances last_ledger to latestLedger when a poll returns no events", async () => {
    const db = new FakeDb()
    db.collection("indexer_cursors").docs.push({ _id: MONGO_CURSOR_ID, paging_token: "tok-0002", last_ledger: 1001 })
    const { rpc } = makeRpc([makeEvent(0), makeEvent(1), makeEvent(2)])

    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(0)

    const cursor = await loadMongoCursor(db as any)
    expect(cursor).toMatchObject({ paging_token: null, last_ledger: 2000 })
  })
})

describe("indexer crash recovery", () => {
  it("loses and duplicates no events when crashing mid-batch", async () => {
    const db = new FakeDb()
    seedInvoices(db, 6)
    const stream = Array.from({ length: 6 }, (_, i) => makeEvent(i))
    const { rpc } = makeRpc(stream)

    // Crash while applying the 4th event: events 0-2 are fully applied, event 3
    // is stored but not applied, and the cursor is never saved.
    const invoices = db.collection("invoices")
    invoices.failOn = (op, filter) => op === "updateOne" && filter.invoice_id === "3"
    await expect(pollOnce(rpc, CONTRACT_ID, db as any)).rejects.toThrow(/simulated crash/)
    expect(await loadMongoCursor(db as any)).toBeNull()

    // Restart: the whole batch is replayed from the original start ledger.
    invoices.failOn = null
    const applied = await pollOnce(rpc, CONTRACT_ID, db as any)

    // Only the events not yet applied (3, 4, 5) run again.
    expect(applied).toBe(3)
    const stored = db.collection("invoice_events").docs
    expect(stored.map((d) => d.event_id).sort()).toEqual(stream.map((e) => e.id))
    expect(stored.every((d) => d.applied)).toBe(true)
    expect(invoices.docs.every((d) => d.status === "Paid")).toBe(true)
    expect(await loadMongoCursor(db as any)).toMatchObject({ paging_token: "tok-0005", last_ledger: 1002 })
  })

  it("keeps progress across batches when crashing before the cursor save", async () => {
    const db = new FakeDb()
    const stream = Array.from({ length: 6 }, (_, i) => makeEvent(i))
    const { rpc } = makeRpc(stream, 2)

    await pollOnce(rpc, CONTRACT_ID, db as any) // events 0-1
    const cursors = db.collection("indexer_cursors")
    cursors.failOn = (op) => op === "updateOne"
    await expect(pollOnce(rpc, CONTRACT_ID, db as any)).rejects.toThrow() // events 2-3 applied, cursor not saved
    cursors.failOn = null

    // Replays 2-3 (no-ops) and then continues with 4-5.
    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(0)
    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(2)
    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(0)

    const ids = db.collection("invoice_events").docs.map((d) => d.event_id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })
})

describe("indexer idempotency", () => {
  it("ignores duplicate events with the same id", async () => {
    const db = new FakeDb()
    const event = makeEvent(0)
    const { rpc } = makeRpc([event, { ...event, pagingToken: "tok-0000b" }])

    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(1)
    expect(db.collection("invoice_events").docs).toHaveLength(1)
  })

  it("is a no-op when the same batch is processed twice", async () => {
    const db = new FakeDb()
    const stream = [makeEvent(0), makeEvent(1)]
    const { rpc } = makeRpc(stream)

    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(2)
    // Simulate a lost cursor: the next poll replays from the start ledger.
    db.collection("indexer_cursors").docs = []
    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(0)
    expect(db.collection("invoice_events").docs).toHaveLength(2)
  })

  it("skips untracked event types", async () => {
    const db = new FakeDb()
    const { rpc } = makeRpc([makeEvent(0, "something_else"), makeEvent(1)])

    expect(await pollOnce(rpc, CONTRACT_ID, db as any)).toBe(1)
    expect(await loadMongoCursor(db as any)).toMatchObject({ paging_token: "tok-0001" })
  })
})
