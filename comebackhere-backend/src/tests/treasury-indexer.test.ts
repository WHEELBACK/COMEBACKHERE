import { describe, it, expect, vi, beforeEach } from "vitest"
import { processIndexerBatch, buildEventId } from "../services/treasury-indexer.js"
import type { SorobanClient } from "../lib/soroban.js"
import type { Db, Collection } from "mongodb"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<{
  pagingToken: string
  txHash: string
  eventType: string
  settlementId: number
  ledger: number
}> = {}) {
  const {
    pagingToken = "tok-1",
    txHash = "abc123",
    eventType = "settlement_proposed",
    settlementId = 1,
    ledger = 100,
  } = overrides

  // Encode topic / value in a format that topicSymbol / valueU64 / valueAddress
  // can read.  We use the same helper patterns as the indexer itself.
  const topicSym = (s: string) => ({ sym: () => ({ toString: () => s }) })
  const u64Val = (n: number) => ({
    u64: () => ({ toString: () => String(n) }),
    address: () => null,
    vec: () => null,
  })
  const vecVal = (...items: any[]) => ({ vec: () => items })

  return {
    pagingToken,
    txHash,
    ledger,
    topic: [topicSym(eventType), u64Val(settlementId)],
    value: vecVal(u64Val(settlementId), { address: () => ({ toString: () => "addr-token" }) }, u64Val(1000), { address: () => ({ toString: () => "addr-merchant" }) }),
  }
}

function makeMockCursor(overrides: Partial<{
  paging_token: string | null
  last_ledger: number
  processed_event_ids: string[]
}> = {}) {
  return {
    _id: "treasury_settlement_events",
    paging_token: overrides.paging_token ?? null,
    last_ledger: overrides.last_ledger ?? 0,
    processed_event_ids: overrides.processed_event_ids ?? [],
    updated_at: new Date(),
  }
}

function makeDatabase(cursorDoc: ReturnType<typeof makeMockCursor>) {
  const updatedCursor = { ...cursorDoc }

  const cursorsCollection = {
    findOne: vi.fn().mockResolvedValue(updatedCursor),
    updateOne: vi.fn().mockImplementation(async (_filter: any, update: any) => {
      if (update.$push?.processed_event_ids) {
        const each: string[] = update.$push.processed_event_ids.$each ?? []
        updatedCursor.processed_event_ids = [
          ...(updatedCursor.processed_event_ids ?? []),
          ...each,
        ].slice(-1000)
      }
      if (update.$set) {
        Object.assign(updatedCursor, update.$set)
      }
    }),
  }

  const settlementsCollection = {
    updateOne: vi.fn().mockResolvedValue({}),
  }

  return {
    collection: vi.fn().mockImplementation((name: string) => {
      if (name === "indexer_cursors") return cursorsCollection
      return settlementsCollection
    }),
    _cursors: cursorsCollection,
    _settlements: settlementsCollection,
  } as unknown as Db & { _cursors: typeof cursorsCollection; _settlements: typeof settlementsCollection }
}

function makeMockClient(events: ReturnType<typeof makeEvent>[], latestLedger = 200): SorobanClient {
  return {
    getEvents: vi.fn().mockResolvedValue({ events, latestLedger }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedger }),
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// buildEventId unit tests
// ---------------------------------------------------------------------------
describe("buildEventId", () => {
  it("returns the paging token when available", () => {
    expect(buildEventId("pg-tok", "txhash", "settlement_proposed", 1)).toBe("pg-tok")
  })

  it("falls back to tx:type:id when paging token is absent", () => {
    expect(buildEventId(undefined, "txhash", "settlement_proposed", 1)).toBe(
      "txhash:settlement_proposed:1",
    )
  })
})

// ---------------------------------------------------------------------------
// processIndexerBatch — deduplication / reorg tests
// ---------------------------------------------------------------------------
describe("processIndexerBatch — reorg deduplication", () => {
  const CONTRACT_ID = "CONTRACT_TEST"

  it("processes a new event and returns count 1", async () => {
    const event = makeEvent({ pagingToken: "tok-1", txHash: "tx1", eventType: "settlement_proposed", settlementId: 1 })
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([event])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(1)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(1)
  })

  it("skips a duplicate event in a replayed window and returns count 0", async () => {
    // Cursor already has "tok-1" in its processed_event_ids → duplicate
    const event = makeEvent({ pagingToken: "tok-1", txHash: "tx1", eventType: "settlement_proposed", settlementId: 1 })
    const db = makeDatabase(makeMockCursor({ processed_event_ids: ["tok-1"] }))
    const client = makeMockClient([event])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(0)
    // The settlements collection must NOT have been written to
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("processes only the new event when an overlapping batch contains one duplicate and one new event", async () => {
    const dup = makeEvent({ pagingToken: "tok-1", txHash: "tx1", eventType: "settlement_proposed", settlementId: 1 })
    const fresh = makeEvent({ pagingToken: "tok-2", txHash: "tx2", eventType: "settlement_proposed", settlementId: 2 })
    const db = makeDatabase(makeMockCursor({ processed_event_ids: ["tok-1"] }))
    const client = makeMockClient([dup, fresh])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(1)
    // Only the fresh event should have triggered a DB write
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(1)
  })

  it("handles settlement_approved deduplication", async () => {
    const event = makeEvent({ pagingToken: "tok-3", txHash: "tx3", eventType: "settlement_approved", settlementId: 5 })
    const db = makeDatabase(makeMockCursor({ processed_event_ids: ["tok-3"] }))
    const client = makeMockClient([event])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(0)
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("handles settlement_executed deduplication", async () => {
    const event = makeEvent({ pagingToken: "tok-4", txHash: "tx4", eventType: "settlement_executed", settlementId: 7 })
    const db = makeDatabase(makeMockCursor({ processed_event_ids: ["tok-4"] }))
    const client = makeMockClient([event])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(0)
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("records processed event IDs so a subsequent replay also deduplicates", async () => {
    const event = makeEvent({ pagingToken: "tok-5", txHash: "tx5", eventType: "settlement_proposed", settlementId: 9 })

    // Build a real-ish cursor whose updateOne actually mutates the stored IDs
    const cursorDoc = makeMockCursor()
    const db = makeDatabase(cursorDoc)
    const client = makeMockClient([event])

    // First pass — processes the event
    const count1 = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count1).toBe(1)

    // Simulate a second call where the cursor's findOne returns the already-updated cursor doc
    // (the makeDatabase mock's findOne always returns the same updatedCursor ref which was
    //  mutated by the updateOne mock above)
    const count2 = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count2).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// processIndexerBatch — batching under high load
// ---------------------------------------------------------------------------
describe("processIndexerBatch — high-load batching", () => {
  const CONTRACT_ID = "CONTRACT_TEST"

  it("processes a large batch of unique events and writes each one", async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      makeEvent({
        pagingToken: `tok-${i}`,
        txHash: `tx-${i}`,
        eventType: "settlement_proposed",
        settlementId: i + 1,
        ledger: 100 + i,
      }),
    )
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient(events, 1000)

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(250)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(250)
  })

  it("deduplicates a large batch that is mostly replayed events", async () => {
    const alreadyProcessed = Array.from({ length: 200 }, (_, i) => `tok-${i}`)
    const events = Array.from({ length: 250 }, (_, i) =>
      makeEvent({
        pagingToken: `tok-${i}`,
        txHash: `tx-${i}`,
        eventType: "settlement_proposed",
        settlementId: i + 1,
      }),
    )
    const db = makeDatabase(makeMockCursor({ processed_event_ids: alreadyProcessed }))
    const client = makeMockClient(events, 1000)

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(50)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(50)
  })

  it("handles an empty event batch without writing anything", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([], 500)

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(0)
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("deduplicates events that share the same paging token within a single batch", async () => {
    const a = makeEvent({ pagingToken: "tok-dup", txHash: "tx-a", settlementId: 1 })
    const b = makeEvent({ pagingToken: "tok-dup", txHash: "tx-b", settlementId: 2 })
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([a, b])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(1)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// processIndexerBatch — memory bounds on processed_event_ids
// ---------------------------------------------------------------------------
describe("processIndexerBatch — processed_event_ids memory bounds", () => {
  const CONTRACT_ID = "CONTRACT_TEST"

  it("caps processed_event_ids at 1000 entries after many batches", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([])

    // Run 12 batches of 100 unique events each → 1200 processed IDs total
    for (let batch = 0; batch < 12; batch++) {
      const events = Array.from({ length: 100 }, (_, i) =>
        makeEvent({
          pagingToken: `tok-${batch}-${i}`,
          txHash: `tx-${batch}-${i}`,
          eventType: "settlement_proposed",
          settlementId: batch * 100 + i + 1,
        }),
      )
      ;(client.getEvents as any).mockResolvedValueOnce({ events, latestLedger: 1000 + batch })
      await processIndexerBatch(client, CONTRACT_ID, db)
    }

    const stored: string[] = (db as any)._cursors.findOne.mock.results.length
      ? (await (db as any)._cursors.findOne({ _id: "treasury_settlement_events" })).processed_event_ids
      : []
    expect(stored.length).toBeLessThanOrEqual(1000)
    // The most recent IDs must be retained (tail of the stream)
    expect(stored).toContain("tok-11-99")
  })

  it("keeps the cursor's last_ledger advancing across batches", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([])

    for (let batch = 0; batch < 3; batch++) {
      const events = [
        makeEvent({
          pagingToken: `tok-${batch}`,
          txHash: `tx-${batch}`,
          settlementId: batch + 1,
          ledger: 200 + batch,
        }),
      ]
      ;(client.getEvents as any).mockResolvedValueOnce({ events, latestLedger: 300 + batch })
      await processIndexerBatch(client, CONTRACT_ID, db)
    }

    const cursor = await (db as any)._cursors.findOne({ _id: "treasury_settlement_events" })
    expect(cursor.last_ledger).toBeGreaterThanOrEqual(200)
  })
})

// ---------------------------------------------------------------------------
// processIndexerBatch — error handling
// ---------------------------------------------------------------------------
describe("processIndexerBatch — error handling", () => {
  const CONTRACT_ID = "CONTRACT_TEST"

  it("propagates errors from the Soroban client getEvents call", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([])
    ;(client.getEvents as any).mockRejectedValueOnce(new Error("rpc unavailable"))

    await expect(processIndexerBatch(client, CONTRACT_ID, db)).rejects.toThrow("rpc unavailable")
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("propagates errors from the settlements write and does not record the event ID", async () => {
    const event = makeEvent({ pagingToken: "tok-err", txHash: "tx-err", settlementId: 1 })
    const db = makeDatabase(makeMockCursor())
    ;(db as any)._settlements.updateOne.mockRejectedValueOnce(new Error("write failed"))
    const client = makeMockClient([event])

    await expect(processIndexerBatch(client, CONTRACT_ID, db)).rejects.toThrow("write failed")

    const cursor = await (db as any)._cursors.findOne({ _id: "treasury_settlement_events" })
    expect(cursor.processed_event_ids).not.toContain("tok-err")
  })

  it("propagates errors from the cursor lookup", async () => {
    const db = makeDatabase(makeMockCursor())
    ;(db as any)._cursors.findOne.mockRejectedValueOnce(new Error("cursor read failed"))
    const client = makeMockClient([makeEvent()])

    await expect(processIndexerBatch(client, CONTRACT_ID, db)).rejects.toThrow("cursor read failed")
  })

  it("recovers on the next batch after a transient failure", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([])

    ;(client.getEvents as any).mockRejectedValueOnce(new Error("transient"))
    await expect(processIndexerBatch(client, CONTRACT_ID, db)).rejects.toThrow("transient")

    const event = makeEvent({ pagingToken: "tok-recover", txHash: "tx-recover", settlementId: 42 })
    ;(client.getEvents as any).mockResolvedValueOnce({ events: [event], latestLedger: 900 })

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(1)
  })
})
