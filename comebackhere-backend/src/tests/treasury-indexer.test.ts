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
// processIndexerBatch — high-load edge cases (#1067 / #1068)
// ---------------------------------------------------------------------------
describe("processIndexerBatch — high-load edge cases", () => {
  const CONTRACT_ID = "CONTRACT_TEST"

  it("returns 0 and performs no writes for an empty event batch", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([], 200)

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(0)
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("skips malformed events without throwing and still processes valid ones", async () => {
    const valid = makeEvent({ pagingToken: "tok-valid", txHash: "txv", eventType: "settlement_proposed", settlementId: 1 })
    // Malformed: missing topic / value accessors entirely
    const malformed = {
      pagingToken: "tok-bad",
      txHash: "txb",
      ledger: 100,
      topic: [],
      value: {},
    } as unknown as ReturnType<typeof makeEvent>

    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([malformed, valid])

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    expect(count).toBe(1)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(1)
  })

  it("does not throw when the cursor document is missing or corrupt", async () => {
    const event = makeEvent({ pagingToken: "tok-c1", txHash: "txc1", eventType: "settlement_proposed", settlementId: 1 })
    const db = makeDatabase(makeMockCursor())
    // Corrupt cursor: findOne returns null
    ;(db as any)._cursors.findOne.mockResolvedValueOnce(null)
    const client = makeMockClient([event])

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    expect(count).toBe(1)
  })

  it("tolerates a corrupt processed_event_ids field (non-array)", async () => {
    const event = makeEvent({ pagingToken: "tok-c2", txHash: "txc2", eventType: "settlement_proposed", settlementId: 2 })
    const db = makeDatabase(makeMockCursor())
    ;(db as any)._cursors.findOne.mockResolvedValueOnce({
      _id: "treasury_settlement_events",
      paging_token: null,
      last_ledger: 0,
      processed_event_ids: "not-an-array",
      updated_at: new Date(),
    })
    const client = makeMockClient([event])

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    expect(count).toBe(1)
  })

  it("deduplicates repeated paging tokens within a single batch", async () => {
    const first = makeEvent({ pagingToken: "tok-dup", txHash: "txd1", eventType: "settlement_proposed", settlementId: 1 })
    const second = makeEvent({ pagingToken: "tok-dup", txHash: "txd2", eventType: "settlement_proposed", settlementId: 2 })
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([first, second])

    const count = await processIndexerBatch(client, CONTRACT_ID, db)
    expect(count).toBe(1)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(1)
  })

  it("degrades gracefully when the RPC getEvents call fails", async () => {
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient([])
    ;(client.getEvents as any).mockRejectedValueOnce(new Error("RPC unavailable"))

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    expect(count).toBe(0)
    expect((db as any)._settlements.updateOne).not.toHaveBeenCalled()
  })

  it("degrades gracefully when the settlements write fails", async () => {
    const event = makeEvent({ pagingToken: "tok-w1", txHash: "txw1", eventType: "settlement_proposed", settlementId: 1 })
    const db = makeDatabase(makeMockCursor())
    ;(db as any)._settlements.updateOne.mockRejectedValueOnce(new Error("write conflict"))
    const client = makeMockClient([event])

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    // The failed event must not be counted as processed
    expect(count).toBe(0)
  })

  it("handles a large batch without throwing", async () => {
    const events = Array.from({ length: 500 }, (_, i) =>
      makeEvent({ pagingToken: `tok-${i}`, txHash: `tx-${i}`, eventType: "settlement_proposed", settlementId: i + 1 }),
    )
    const db = makeDatabase(makeMockCursor())
    const client = makeMockClient(events)

    let count: number | undefined
    await expect(
      (async () => {
        count = await processIndexerBatch(client, CONTRACT_ID, db)
      })(),
    ).resolves.not.toThrow()

    expect(count).toBe(500)
    expect((db as any)._settlements.updateOne).toHaveBeenCalledTimes(500)
  })
})
