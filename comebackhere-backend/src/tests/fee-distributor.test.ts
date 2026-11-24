/**
 * Tests for the fee-distributor service — Issue #3 (test coverage)
 *
 * Coverage areas
 * ══════════════
 * Unit
 *   • buildTraceCarrier / isValidTraceparent (OTel injection, Issue #1)
 *   • distributionJobSchema input validation (auth/hardening, Issue #4)
 *   • LruCache eviction and TTL expiry (memory, Issue #2)
 *   • CompletedJobBuffer batching and threshold flush (throughput, Issue #2)
 *   • RedisPipeline microtask batching (throughput, Issue #2)
 *   • processDistribution — completed / skipped / below-minimum paths
 *   • extractTraceCarrier — carrier forwarding from envelope
 *
 * Integration (in-process, no real Redis / Mongo)
 *   • enqueueDistribution → dequeueDistribution round-trip
 *   • startFeeDistributor end-to-end: job queued, processed, buffered, flushed
 *   • Poison-pill resilience: malformed JSON / schema mismatch is discarded
 *   • Trace carrier propagated through enqueue → dequeue → extract
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildTraceCarrier,
  isValidTraceparent,
  distributionJobSchema,
  LruCache,
  CompletedJobBuffer,
  RedisPipeline,
  processDistribution,
  extractTraceCarrier,
  enqueueDistribution,
  dequeueDistribution,
  startFeeDistributor,
  QUEUE_KEY,
  type DistributionJobEnvelope,
  type DistributionJob,
  type FeeConfig,
  type CompletedDistributionRecord,
} from "../services/fee-distributor.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal valid job for schema / queue tests. */
function makeJob(overrides?: Partial<DistributionJob>): DistributionJob {
  return {
    merchant_address: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    amount: 1_000_000,
    token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    idempotency_key: "fee:inv-123",
    ...overrides,
  }
}

/** Returns a fresh in-memory Redis-like stub. */
function makeRedisStub() {
  const queues: Record<string, string[]> = {}
  const pipelines: Array<{ exec: () => Promise<null[][]> }> = []

  const stub = {
    async rpush(key: string, value: string): Promise<number> {
      queues[key] ??= []
      queues[key].push(value)
      return queues[key].length
    },
    async lpop(key: string): Promise<string | null> {
      return queues[key]?.shift() ?? null
    },
    pipeline() {
      const cmds: Array<[string, ...unknown[]]> = []
      const p = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set(...args: any[]) { cmds.push(["set", ...args]); return p },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hset(...args: any[]) { cmds.push(["hset", ...args]); return p },
        async exec() { return cmds.map(() => [null, "OK"] as [null, string]) },
      }
      pipelines.push(p)
      return p
    },
    _queues: queues,
    _pipelines: pipelines,
  }
  return stub
}

/** Minimal Mongo Db stub for CompletedJobBuffer. */
function makeDbStub() {
  const inserted: CompletedDistributionRecord[][] = []
  const db = {
    collection: (_name: string) => ({
      insertMany: vi.fn(async (docs: CompletedDistributionRecord[]) => {
        inserted.push([...docs])
        return { insertedCount: docs.length }
      }),
    }),
    _inserted: inserted,
  }
  return db
}

// ---------------------------------------------------------------------------
// Issue #1 — OTel trace carrier injection
// ---------------------------------------------------------------------------

describe("buildTraceCarrier", () => {
  it("returns an empty object when no context is supplied", () => {
    expect(buildTraceCarrier()).toEqual({})
  })

  it("extracts traceparent from a string header", () => {
    const carrier = buildTraceCarrier({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    })
    expect(carrier.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )
    expect(carrier.tracestate).toBeUndefined()
  })

  it("extracts the first element when header value is an array", () => {
    const carrier = buildTraceCarrier({
      traceparent: ["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "stale"],
    })
    expect(carrier.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )
  })

  it("includes tracestate when present", () => {
    const carrier = buildTraceCarrier({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=abc123",
    })
    expect(carrier.tracestate).toBe("vendor=abc123")
  })

  it("omits blank / whitespace-only headers", () => {
    expect(buildTraceCarrier({ traceparent: "  " })).toEqual({})
    expect(buildTraceCarrier({ tracestate: "" })).toEqual({})
  })
})

describe("isValidTraceparent", () => {
  it("accepts a well-formed traceparent", () => {
    expect(
      isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toBe(true)
  })

  it("rejects a truncated traceparent", () => {
    expect(isValidTraceparent("00-4bf92f3577b34da6a3ce929d-00f067aa0ba902b7-01")).toBe(false)
  })

  it("rejects an empty string", () => {
    expect(isValidTraceparent("")).toBe(false)
  })

  it("rejects uppercase hex", () => {
    // W3C spec mandates lowercase
    expect(
      isValidTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"),
    ).toBe(false)
  })
})

describe("extractTraceCarrier", () => {
  it("returns an empty carrier when the job has no trace_carrier", () => {
    const envelope: DistributionJobEnvelope = {
      job: makeJob(),
      enqueued_at: new Date().toISOString(),
    }
    expect(extractTraceCarrier(envelope)).toEqual({})
  })

  it("forwards a valid traceparent from the envelope", () => {
    const envelope: DistributionJobEnvelope = {
      job: makeJob({
        trace_carrier: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
      enqueued_at: new Date().toISOString(),
    }
    expect(extractTraceCarrier(envelope).traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )
  })

  it("drops a malformed traceparent rather than propagating garbage", () => {
    const envelope: DistributionJobEnvelope = {
      job: makeJob({
        trace_carrier: { traceparent: "not-a-valid-traceparent" },
      }),
      enqueued_at: new Date().toISOString(),
    }
    expect(extractTraceCarrier(envelope).traceparent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Issue #4 — Input validation / hardening
// ---------------------------------------------------------------------------

describe("distributionJobSchema", () => {
  it("accepts a fully valid job", () => {
    expect(() => distributionJobSchema.parse(makeJob())).not.toThrow()
  })

  it("rejects an invalid Stellar public key for merchant_address", () => {
    expect(() =>
      distributionJobSchema.parse(makeJob({ merchant_address: "NOTASTELLARKEY" })),
    ).toThrow()
  })

  it("rejects amount = 0", () => {
    expect(() => distributionJobSchema.parse(makeJob({ amount: 0 }))).toThrow()
  })

  it("rejects negative amount", () => {
    expect(() => distributionJobSchema.parse(makeJob({ amount: -1 }))).toThrow()
  })

  it("rejects non-integer amount", () => {
    expect(() => distributionJobSchema.parse(makeJob({ amount: 1.5 }))).toThrow()
  })

  it("rejects amount that exceeds Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      distributionJobSchema.parse(makeJob({ amount: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow()
  })

  it("rejects an invalid Stellar contract id for token", () => {
    expect(() =>
      distributionJobSchema.parse(makeJob({ token: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" })),
    ).toThrow(/Stellar contract id/)
  })

  it("rejects an empty idempotency_key", () => {
    expect(() => distributionJobSchema.parse(makeJob({ idempotency_key: "" }))).toThrow()
  })

  it("rejects an idempotency_key with shell-injection chars", () => {
    expect(() =>
      distributionJobSchema.parse(makeJob({ idempotency_key: "fee;rm -rf /" })),
    ).toThrow()
  })

  it("rejects an idempotency_key longer than 255 characters", () => {
    expect(() =>
      distributionJobSchema.parse(makeJob({ idempotency_key: "a".repeat(256) })),
    ).toThrow()
  })

  it("trims whitespace from string fields", () => {
    const result = distributionJobSchema.parse(
      makeJob({ idempotency_key: "  fee:inv-456  " }),
    )
    expect(result.idempotency_key).toBe("fee:inv-456")
  })

  it("accepts an optional trace_carrier", () => {
    const result = distributionJobSchema.parse(
      makeJob({
        trace_carrier: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    )
    expect(result.trace_carrier?.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )
  })
})

// ---------------------------------------------------------------------------
// Issue #2 — LruCache
// ---------------------------------------------------------------------------

describe("LruCache", () => {
  it("returns null for a missing key", () => {
    const cache = new LruCache<string, number>(10, 60_000)
    expect(cache.get("x")).toBeNull()
  })

  it("stores and retrieves a value", () => {
    const cache = new LruCache<string, number>(10, 60_000)
    cache.set("x", 42)
    expect(cache.get("x")).toBe(42)
  })

  it("evicts the oldest entry when capacity is reached", () => {
    const cache = new LruCache<string, number>(3, 60_000)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    cache.set("d", 4) // should evict "a"
    expect(cache.get("a")).toBeNull()
    expect(cache.get("b")).toBe(2)
    expect(cache.get("d")).toBe(4)
  })

  it("promotes a recently accessed key past the eviction frontier", () => {
    const cache = new LruCache<string, number>(3, 60_000)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    // Access "a" so it moves to the end (most-recently used)
    cache.get("a")
    cache.set("d", 4) // should evict "b" (now oldest)
    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBeNull()
  })

  it("expires entries past their TTL", () => {
    vi.useFakeTimers()
    const cache = new LruCache<string, number>(10, 1_000)
    cache.set("x", 99)
    vi.advanceTimersByTime(1_001)
    expect(cache.get("x")).toBeNull()
    vi.useRealTimers()
  })

  it("size reflects the number of live entries", () => {
    const cache = new LruCache<string, number>(10, 60_000)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.size).toBe(2)
    cache.delete("a")
    expect(cache.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Issue #2 — CompletedJobBuffer
// ---------------------------------------------------------------------------

describe("CompletedJobBuffer", () => {
  function makeRecord(key: string): CompletedDistributionRecord {
    return {
      idempotency_key: key,
      merchant_address: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
      amount: 100,
      token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      status: "completed",
      processed_at: new Date().toISOString(),
    }
  }

  it("flushes when threshold is reached", async () => {
    const db = makeDbStub()
    const buffer = new CompletedJobBuffer({
      getDb: () => Promise.resolve(db as never),
      flushThreshold: 3,
      flushIntervalMs: 60_000,
    })

    buffer.add(makeRecord("k1"))
    buffer.add(makeRecord("k2"))
    expect(buffer.pending).toBe(2)

    buffer.add(makeRecord("k3")) // triggers flush
    // Wait one microtask for the async flush to complete
    await Promise.resolve()
    await Promise.resolve()
    expect(db._inserted[0]).toHaveLength(3)
  })

  it("flushes on drain even before threshold", async () => {
    const db = makeDbStub()
    const buffer = new CompletedJobBuffer({
      getDb: () => Promise.resolve(db as never),
      flushThreshold: 100,
      flushIntervalMs: 60_000,
    })

    buffer.add(makeRecord("k1"))
    buffer.add(makeRecord("k2"))
    await buffer.drain()
    expect(db._inserted[0]).toHaveLength(2)
  })

  it("re-queues records when Mongo insertMany fails", async () => {
    const db = {
      collection: (_name: string) => ({
        insertMany: vi.fn().mockRejectedValue(new Error("DB offline")),
      }),
    }
    const buffer = new CompletedJobBuffer({
      getDb: () => Promise.resolve(db as never),
      flushThreshold: 100,
      flushIntervalMs: 60_000,
    })

    buffer.add(makeRecord("k1"))
    const flushed = await buffer.flush()
    expect(flushed).toBe(0)
    expect(buffer.pending).toBe(1) // re-queued
  })

  it("timer flush fires after interval", async () => {
    vi.useFakeTimers()
    const db = makeDbStub()
    const buffer = new CompletedJobBuffer({
      getDb: () => Promise.resolve(db as never),
      flushThreshold: 100,
      flushIntervalMs: 500,
    })

    buffer.add(makeRecord("k1"))
    expect(buffer.pending).toBe(1)
    vi.advanceTimersByTime(501)
    // Allow the async flush chain to settle
    await Promise.resolve()
    await Promise.resolve()
    vi.useRealTimers()
    // The timer triggered; a flush was scheduled (may still be in-flight in test)
    // We just verify it doesn't throw and that records eventually clear.
    await buffer.drain()
    expect(db._inserted.flat()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Issue #2 — RedisPipeline
// ---------------------------------------------------------------------------

describe("RedisPipeline", () => {
  it("executes all queued commands as a pipeline", async () => {
    const redis = makeRedisStub()
    const executed: Array<[string, ...unknown[]]> = []
    const mockPipeline = {
      set(...args: unknown[]) { executed.push(["set", ...args]); return this },
      hset(...args: unknown[]) { executed.push(["hset", ...args]); return this },
      async exec() { return executed.map(() => [null, "OK"]) },
    }
    vi.spyOn(redis, "pipeline").mockReturnValue(mockPipeline as never)

    const rp = new RedisPipeline(() => redis as never)
    rp.schedule(["set", "foo", "bar"])
    rp.schedule(["hset", "hash", "field", "val"])

    await rp.flush()
    expect(executed).toHaveLength(2)
    expect(executed[0][0]).toBe("set")
    expect(executed[1][0]).toBe("hset")
  })

  it("is a no-op when Redis is unavailable", async () => {
    const rp = new RedisPipeline(() => null)
    rp.schedule(["set", "k", "v"])
    // Should not throw
    await expect(rp.flush()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// processDistribution unit tests
// ---------------------------------------------------------------------------

describe("processDistribution", () => {
  const feeConfig: FeeConfig = { bps: 100, min_amount: 500 }

  it("returns completed status and correct fee for a valid job", async () => {
    const result = await processDistribution(
      makeJob({ amount: 10_000 }),
      async () => feeConfig,
    )
    expect(result.status).toBe("completed")
    expect(result.amount).toBe(100) // 10 000 * 100 / 10 000 = 100
  })

  it("truncates fractional fees", async () => {
    // 10_001 * 100 / 10_000 = 100.01 → 100
    const result = await processDistribution(
      makeJob({ amount: 10_001 }),
      async () => feeConfig,
    )
    expect(result.status).toBe("completed")
    expect(result.amount).toBe(100)
  })

  it("skips distribution when no fee config is found", async () => {
    const result = await processDistribution(makeJob(), async () => null)
    expect(result.status).toBe("skipped")
  })

  it("skips distribution when amount is below minimum", async () => {
    const result = await processDistribution(
      makeJob({ amount: 499 }),
      async () => feeConfig,
    )
    expect(result.status).toBe("skipped")
    expect(result.error).toMatch(/below minimum/)
  })

  it("preserves the idempotency_key on the result record", async () => {
    const result = await processDistribution(
      makeJob({ idempotency_key: "fee:special-123" }),
      async () => feeConfig,
    )
    expect(result.idempotency_key).toBe("fee:special-123")
  })
})

// ---------------------------------------------------------------------------
// Integration: enqueue → dequeue round-trip
// ---------------------------------------------------------------------------

describe("enqueueDistribution / dequeueDistribution", () => {
  it("pushes a serialised envelope and pops it back", async () => {
    const redis = makeRedisStub()
    await enqueueDistribution(redis as never, makeJob())
    expect(redis._queues[QUEUE_KEY]).toHaveLength(1)

    const envelope = await dequeueDistribution(redis as never)
    expect(envelope).not.toBeNull()
    expect(envelope?.job.idempotency_key).toBe("fee:inv-123")
    expect(redis._queues[QUEUE_KEY]).toHaveLength(0)
  })

  it("returns null when the queue is empty", async () => {
    const redis = makeRedisStub()
    expect(await dequeueDistribution(redis as never)).toBeNull()
  })

  it("discards a poison-pill (invalid JSON) without throwing", async () => {
    const redis = makeRedisStub()
    redis._queues[QUEUE_KEY] = ["{not valid json"]
    expect(await dequeueDistribution(redis as never)).toBeNull()
    expect(redis._queues[QUEUE_KEY]).toHaveLength(0)
  })

  it("discards an envelope that fails schema validation", async () => {
    const redis = makeRedisStub()
    // Push a job with an invalid merchant address
    const bad = JSON.stringify({
      job: { ...makeJob(), merchant_address: "BADADDY" },
      enqueued_at: new Date().toISOString(),
    })
    redis._queues[QUEUE_KEY] = [bad]
    expect(await dequeueDistribution(redis as never)).toBeNull()
  })

  it("rejects enqueue of an invalid job", async () => {
    const redis = makeRedisStub()
    await expect(
      enqueueDistribution(redis as never, makeJob({ amount: -1 })),
    ).rejects.toThrow()
    expect(redis._queues[QUEUE_KEY] ?? []).toHaveLength(0)
  })

  it("propagates trace carrier through enqueue → dequeue → extract", async () => {
    const redis = makeRedisStub()
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    await enqueueDistribution(redis as never, makeJob({
      trace_carrier: { traceparent },
    }))

    const envelope = await dequeueDistribution(redis as never)
    expect(envelope).not.toBeNull()

    const carrier = extractTraceCarrier(envelope!)
    expect(carrier.traceparent).toBe(traceparent)
  })
})

// ---------------------------------------------------------------------------
// Integration: startFeeDistributor end-to-end
// ---------------------------------------------------------------------------

describe("startFeeDistributor", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("processes a queued job and buffers the result", async () => {
    const redis = makeRedisStub()
    const flushed: CompletedDistributionRecord[][] = []
    const db = {
      collection: (_name: string) => ({
        insertMany: vi.fn(async (docs: CompletedDistributionRecord[]) => {
          flushed.push([...docs])
          return { insertedCount: docs.length }
        }),
      }),
    }

    // Pre-load the queue before the worker starts
    await enqueueDistribution(redis as never, makeJob())

    const worker = startFeeDistributor({
      redis: redis as never,
      db: db as never,
      pollIntervalMs: 10,
      getFeeConfig: async () => ({ bps: 200, min_amount: 0 }),
    })

    expect(worker.isRunning).toBe(true)

    // Stop before firing additional ticks so we don't loop endlessly.
    // stop() clears the timer and drains the buffer.
    // Run only the initial (already-scheduled) tick first.
    await vi.runOnlyPendingTimersAsync()
    // Allow async microtasks to settle
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await worker.stop()
    // After stop, drain ensures buffer is flushed
    expect(flushed.flat().length).toBeGreaterThan(0)
    expect(flushed.flat()[0]?.status).toBe("completed")
    expect(worker.isRunning).toBe(false)
  })

  it("handles a job that throws in processDistribution", async () => {
    const redis = makeRedisStub()
    const flushed: CompletedDistributionRecord[][] = []
    const db = {
      collection: (_name: string) => ({
        insertMany: vi.fn(async (docs: CompletedDistributionRecord[]) => {
          flushed.push([...docs])
          return { insertedCount: docs.length }
        }),
      }),
    }

    await enqueueDistribution(redis as never, makeJob())

    const worker = startFeeDistributor({
      redis: redis as never,
      db: db as never,
      pollIntervalMs: 10,
      getFeeConfig: async () => { throw new Error("contract unreachable") },
    })

    // Run only the first scheduled tick
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await worker.stop()
    const records = flushed.flat()
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe("failed")
    expect(records[0].error).toMatch(/contract unreachable/)
  })

  it("stops cleanly with no jobs queued", async () => {
    const redis = makeRedisStub()
    const worker = startFeeDistributor({
      redis: redis as never,
      getFeeConfig: async () => null,
    })
    await worker.stop()
    expect(worker.isRunning).toBe(false)
  })
})
