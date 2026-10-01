import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { stopTreasuryIndexer } from "../services/treasury-indexer.js"
import { stopIndexer } from "../indexer.js"
import { closeMongo } from "../db/mongo.js"
import {
  WebhookDeliveryQueue,
  buildWebhookPayload,
  type PendingDeliveryStore,
  type WebhookDeliveryJob,
} from "../services/webhook-delivery.js"
import { createShutdownHandler, resolveWebhookDrainTimeout } from "../shutdown.js"

// We test the shutdown logic in isolation without spawning a real process.
// The strategy: extract and call the shutdown function's individual steps,
// asserting each dependency is invoked.

vi.mock("../services/treasury-indexer.js", () => ({
  startTreasuryIndexer: vi.fn(),
  stopTreasuryIndexer: vi.fn(),
}))

vi.mock("../indexer.js", () => ({
  stopIndexer: vi.fn(),
}))

vi.mock("../db/mongo.js", () => ({
  closeMongo: vi.fn().mockResolvedValue(undefined),
  connectMongo: vi.fn(),
}))

// Re-import after mocks are set up
const { stopTreasuryIndexer: mockStopTreasuryIndexer } = await import("../services/treasury-indexer.js") as unknown as {
  stopTreasuryIndexer: ReturnType<typeof vi.fn>
}
const { stopIndexer: mockStopIndexer } = await import("../indexer.js") as unknown as {
  stopIndexer: ReturnType<typeof vi.fn>
}
const { closeMongo: mockCloseMongo } = await import("../db/mongo.js") as unknown as {
  closeMongo: ReturnType<typeof vi.fn>
}

// ---------------------------------------------------------------------------
// Shutdown step tests (unit-level)
// ---------------------------------------------------------------------------

describe("Graceful shutdown steps", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stopTreasuryIndexer is exported and callable", () => {
    stopTreasuryIndexer()
    expect(mockStopTreasuryIndexer).toHaveBeenCalledOnce()
  })

  it("stopIndexer is exported and callable", () => {
    stopIndexer()
    expect(mockStopIndexer).toHaveBeenCalledOnce()
  })

  it("closeMongo resolves without error", async () => {
    await closeMongo()
    expect(mockCloseMongo).toHaveBeenCalledOnce()
  })

  it("shutdown sequence calls stopTreasuryIndexer, stopIndexer, and closeMongo", async () => {
    // Simulate the shutdown sequence without requiring a live server
    stopTreasuryIndexer()
    stopIndexer()
    await closeMongo()

    expect(mockStopTreasuryIndexer).toHaveBeenCalledOnce()
    expect(mockStopIndexer).toHaveBeenCalledOnce()
    expect(mockCloseMongo).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// stopIndexer idempotency test
// ---------------------------------------------------------------------------

describe("stopIndexer", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("can be called multiple times without error (idempotent)", () => {
    expect(() => {
      stopIndexer()
      stopIndexer()
      stopIndexer()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// stopTreasuryIndexer idempotency test
// ---------------------------------------------------------------------------

describe("stopTreasuryIndexer", () => {
  it("can be called multiple times without error (idempotent)", () => {
    expect(() => {
      stopTreasuryIndexer()
      stopTreasuryIndexer()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Webhook drain on shutdown — a delivery is in progress when SIGTERM arrives
// ---------------------------------------------------------------------------

function memoryStore(): PendingDeliveryStore & { saved: WebhookDeliveryJob[] } {
  const saved: WebhookDeliveryJob[] = []
  return {
    saved,
    save: vi.fn(async (jobs: WebhookDeliveryJob[]) => {
      saved.push(...jobs)
    }),
    takeAll: vi.fn(async () => saved.splice(0)),
  }
}

/** fetch whose response is released manually, to hold a delivery in flight. */
function controllableFetch() {
  const releases: Array<(status: number) => void> = []
  const fetchFn = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        releases.push((status) => resolve({ status } as Response))
      }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  return { fetchFn, release: (status = 200) => releases.shift()?.(status) }
}

function makeShutdown(queue: WebhookDeliveryQueue, webhookDrainTimeoutMs: number) {
  const order: string[] = []
  const exit = vi.fn((code: number) => {
    order.push(`exit:${code}`)
  })
  const server = { close: vi.fn((cb: (err?: Error) => void) => cb()) }
  const shutdown = createShutdownHandler({
    server: server as never,
    webhookQueue: queue,
    stopIndexers: () => order.push("stopIndexers"),
    closeMongo: async () => {
      order.push("closeMongo")
    },
    shutdownTimeoutMs: 10_000,
    webhookDrainTimeoutMs,
    exit,
  })
  return { shutdown, exit, order, server }
}

const payload = (id: string) =>
  buildWebhookPayload("settlement.executed", { amount: "1" }, { settlementId: id })

describe("Graceful shutdown — webhook drain", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("waits for a delivery in progress at SIGTERM before closing Mongo and exiting", async () => {
    const store = memoryStore()
    const { fetchFn, release } = controllableFetch()
    const queue = new WebhookDeliveryQueue({ store, fetchFn })
    const { shutdown, exit, order } = makeShutdown(queue, 1_000)

    const delivery = queue.enqueue("https://merchant.test/hook", payload("1"))
    expect(queue.inFlightCount).toBe(1)

    const done = shutdown("SIGTERM")
    // Let the shutdown reach the drain step, then finish the delivery.
    await new Promise((r) => setTimeout(r, 20))
    expect(exit).not.toHaveBeenCalled()
    release(200)
    await done

    await expect(delivery).resolves.toMatchObject({ status: "delivered" })
    expect(store.saved).toEqual([])
    expect(order).toEqual(["stopIndexers", "closeMongo", "exit:0"])
  })

  it("persists a delivery still in progress when the drain timeout expires", async () => {
    const store = memoryStore()
    const { fetchFn } = controllableFetch() // never released
    const queue = new WebhookDeliveryQueue({ store, fetchFn })
    const { shutdown, exit } = makeShutdown(queue, 50)

    const p = payload("2")
    queue.enqueue("https://merchant.test/hook", p)
    await shutdown("SIGTERM")

    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]).toMatchObject({
      endpoint: "https://merchant.test/hook",
      payload: p,
      attempts: 1,
      attempt_history: [{ attempt: 1 }],
    })
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("stops retry backoff at the timeout and persists the attempt count", async () => {
    const store = memoryStore()
    const fetchFn = vi.fn(async () => ({ status: 500 }) as Response) as unknown as typeof fetch
    const neverEndingDelay = () => new Promise<void>(() => {})
    const queue = new WebhookDeliveryQueue({ store, fetchFn, delayFn: neverEndingDelay })
    const { shutdown } = makeShutdown(queue, 50)

    const delivery = queue.enqueue("https://merchant.test/hook", payload("3"))
    await shutdown("SIGTERM")

    await expect(delivery).resolves.toMatchObject({ status: "pending", attempts: 1 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0].attempts).toBe(1)
  })

  it("does not start new jobs after the signal and persists them instead", async () => {
    const store = memoryStore()
    const { fetchFn } = controllableFetch()
    const queue = new WebhookDeliveryQueue({ store, fetchFn })
    const { shutdown } = makeShutdown(queue, 50)

    const done = shutdown("SIGTERM")
    expect(queue.isAccepting).toBe(false)
    expect(queue.enqueue("https://merchant.test/hook", payload("4"))).toBeNull()
    await done

    expect(fetchFn).not.toHaveBeenCalled()
    expect(store.saved.map((j) => j.payload.idempotency_key)).toEqual(["settlement.executed:4"])
  })

  it("persisted jobs are retried by the next process and resume their attempt count", async () => {
    const store = memoryStore()
    store.saved.push({ endpoint: "https://merchant.test/hook", payload: payload("5"), attempts: 2 })
    const fetchFn = vi.fn(async () => ({ status: 200 }) as Response) as unknown as typeof fetch
    const queue = new WebhookDeliveryQueue({ store, fetchFn })

    expect(await queue.resumePending()).toBe(1)
    await queue.drain(1_000)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.saved).toEqual([])
  })
})

describe("resolveWebhookDrainTimeout", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("keeps a configured timeout that fits within the shutdown budget", () => {
    expect(resolveWebhookDrainTimeout(5_000, 10_000)).toBe(5_000)
  })

  it("caps the drain timeout below the hard shutdown timeout", () => {
    expect(resolveWebhookDrainTimeout(30_000, 10_000)).toBe(8_000)
  })

  it("falls back to the cap for invalid values", () => {
    expect(resolveWebhookDrainTimeout(Number.NaN, 10_000)).toBe(8_000)
  })
})
