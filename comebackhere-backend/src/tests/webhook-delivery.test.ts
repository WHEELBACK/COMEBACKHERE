import { describe, it, expect, vi } from "vitest"
import { getWebhookRetryConfig } from "../lib/env.js"
import {
  deliverWebhook,
  buildWebhookPayload,
  DEFAULT_MAX_ATTEMPTS,
  BASE_DELAY_MS,
  WebhookDeliveryQueue,
  type WebhookPayload,
  type DeadLetterStore,
  type WebhookDeadLetterRecord,
} from "../services/webhook-delivery.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noDelay = () => Promise.resolve()

describe("webhook retry configuration", () => {
  it("uses bounded defaults when variables are unset", () => {
    expect(getWebhookRetryConfig({})).toEqual({
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterRatio: 0.2,
    })
  })

  it("reads retry limits from the environment", () => {
    expect(getWebhookRetryConfig({
      WEBHOOK_MAX_ATTEMPTS: "8",
      WEBHOOK_BASE_DELAY_MS: "250",
      WEBHOOK_MAX_DELAY_MS: "5000",
      WEBHOOK_JITTER_RATIO: "0.5",
    })).toEqual({ maxAttempts: 8, baseDelayMs: 250, maxDelayMs: 5_000, jitterRatio: 0.5 })
  })

  it("rejects invalid retry settings", () => {
    expect(() => getWebhookRetryConfig({ WEBHOOK_MAX_ATTEMPTS: "0" })).toThrow(/WEBHOOK_MAX_ATTEMPTS/)
    expect(() => getWebhookRetryConfig({ WEBHOOK_JITTER_RATIO: "1.5" })).toThrow(/WEBHOOK_JITTER_RATIO/)
  })
})

function makePayload(overrides?: Partial<WebhookPayload>): WebhookPayload {
  return {
    event_type: "invoice_paid",
    invoice_id: "42",
    idempotency_key: "invoice_paid:42",
    timestamp: new Date().toISOString(),
    data: { amount: 1_000_000 },
    ...overrides,
  }
}

function makeFetch(responses: Array<{ status: number } | Error>): typeof fetch {
  let call = 0
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[call++] ?? responses[responses.length - 1]
    if (r instanceof Error) throw r
    return { status: r.status } as Response
  }) as unknown as typeof fetch
}

function memoryDeadLetters(): DeadLetterStore & { records: Map<string, WebhookDeadLetterRecord> } {
  const records = new Map<string, WebhookDeadLetterRecord>()
  return {
    records,
    async save(record) {
      records.set(record.idempotency_key, { ...record, failed_at: new Date().toISOString() })
    },
    async find(key) {
      return records.get(key) ?? null
    },
    async list() {
      return [...records.values()]
    },
    async delete(key) {
      records.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// deliverWebhook tests
// ---------------------------------------------------------------------------

describe("deliverWebhook", () => {
  it("returns delivered status on first attempt with 200", async () => {
    const fetchFn = makeFetch([{ status: 200 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay)

    expect(record.status).toBe("delivered")
    expect(record.attempts).toBe(1)
    expect(record.last_status_code).toBe(200)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("returns delivered status on first attempt with 201", async () => {
    const fetchFn = makeFetch([{ status: 201 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay)

    expect(record.status).toBe("delivered")
    expect(record.attempts).toBe(1)
  })

  it("retries on non-2xx response and succeeds on second attempt", async () => {
    const fetchFn = makeFetch([{ status: 500 }, { status: 200 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay)

    expect(record.status).toBe("delivered")
    expect(record.attempts).toBe(2)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("retries on network error and succeeds on third attempt", async () => {
    const fetchFn = makeFetch([
      new Error("ECONNREFUSED"),
      new Error("timeout"),
      { status: 200 },
    ])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay)

    expect(record.status).toBe("delivered")
    expect(record.attempts).toBe(3)
    expect(record.last_status_code).toBe(200)
  })

  it("records terminal failed status after max attempts all fail", async () => {
    const fetchFn = makeFetch([{ status: 503 }]) // always 503
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, DEFAULT_MAX_ATTEMPTS, fetchFn, noDelay)

    expect(record.status).toBe("failed")
    expect(record.attempts).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(record.last_status_code).toBe(503)
    expect(fetchFn).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS)
  })

  it("records terminal failed status when all attempts throw network errors", async () => {
    const fetchFn = makeFetch([new Error("connection refused")])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 3, fetchFn, noDelay)

    expect(record.status).toBe("failed")
    expect(record.attempts).toBe(3)
    expect(record.last_error).toContain("connection refused")
    expect(record.last_status_code).toBeNull()
  })

  it("applies exponential backoff delays between attempts", async () => {
    const delays: number[] = []
    const delayFn = (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    }
    const fetchFn = makeFetch([{ status: 500 }, { status: 500 }, { status: 200 }])
    const payload = makePayload()

    await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, delayFn, { jitterRatio: 0 })

    // Two failures → two delays before the successful third attempt
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBe(BASE_DELAY_MS * Math.pow(2, 0)) // 1000ms
    expect(delays[1]).toBe(BASE_DELAY_MS * Math.pow(2, 1)) // 2000ms
  })

  it("does not apply a delay after the final failed attempt", async () => {
    const delays: number[] = []
    const delayFn = (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    }
    const fetchFn = makeFetch([{ status: 500 }]) // always fails
    const payload = makePayload()

    await deliverWebhook("https://example.com/hook", payload, 3, fetchFn, delayFn)

    // 3 attempts → 2 delays (not 3)
    expect(delays).toHaveLength(2)
  })

  it("caps the exponential delay and records every attempt", async () => {
    const delays: number[] = []
    const record = await deliverWebhook(
      "https://example.com/hook",
      makePayload(),
      3,
      makeFetch([{ status: 500 }]),
      async (ms) => { delays.push(ms) },
      { baseDelayMs: 1_000, maxDelayMs: 1_500, jitterRatio: 0, randomFn: () => 0.5 },
    )

    expect(delays).toEqual([1_000, 1_500])
    expect(record.attempt_history).toHaveLength(3)
    expect(record.attempt_history.map((attempt) => attempt.status_code)).toEqual([500, 500, 500])
  })

  it("uses fake timers for the default backoff delay", async () => {
    vi.useFakeTimers()
    try {
      const delivery = deliverWebhook(
        "https://example.com/hook",
        makePayload(),
        2,
        makeFetch([{ status: 500 }, { status: 200 }]),
        undefined,
        { jitterRatio: 0 },
      )
      await vi.runAllTimersAsync()
      await expect(delivery).resolves.toMatchObject({ status: "delivered", attempts: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("persists exhausted deliveries and replays them until success", async () => {
    const deadLetters = memoryDeadLetters()
    const queue = new WebhookDeliveryQueue({
      deadLetterStore: deadLetters,
      maxAttempts: 1,
      fetchFn: makeFetch([{ status: 503 }, { status: 200 }]),
      delayFn: noDelay,
      retryConfig: { jitterRatio: 0 },
    })
    const payload = makePayload()

    const failed = await queue.enqueue("https://example.com/hook", payload)
    expect(failed).toMatchObject({ status: "failed", last_error: "HTTP 503", attempts: 1 })
    expect(deadLetters.records.get(payload.idempotency_key)).toMatchObject({
      endpoint: "https://example.com/hook",
      payload,
      last_error: "HTTP 503",
      attempt_history: [{ attempt: 1, status_code: 503 }],
    })

    const replayed = await queue.replayDeadLetter(payload.idempotency_key)
    expect(replayed).toMatchObject({ status: "delivered" })
    expect(deadLetters.records.has(payload.idempotency_key)).toBe(false)
  })

  it("preserves the idempotency_key across all retry attempts", async () => {
    const capturedKeys: string[] = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}")
      capturedKeys.push(body.idempotency_key)
      return { status: 500 } as Response
    }) as unknown as typeof fetch

    const payload = makePayload({ idempotency_key: "invoice_paid:99" })

    await deliverWebhook("https://example.com/hook", payload, 3, fetchFn, noDelay)

    expect(capturedKeys).toHaveLength(3)
    expect(capturedKeys.every((k) => k === "invoice_paid:99")).toBe(true)
  })

  it("sets X-Idempotency-Key header on every request", async () => {
    const capturedHeaders: Record<string, string>[] = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>)
      return { status: 500 } as Response
    }) as unknown as typeof fetch

    const payload = makePayload({ idempotency_key: "invoice_paid:7" })

    await deliverWebhook("https://example.com/hook", payload, 2, fetchFn, noDelay)

    expect(capturedHeaders).toHaveLength(2)
    expect(capturedHeaders[0]["X-Idempotency-Key"]).toBe("invoice_paid:7")
    expect(capturedHeaders[1]["X-Idempotency-Key"]).toBe("invoice_paid:7")
  })

  it("forwards X-Request-Id on every attempt when a correlationId is supplied", async () => {
    const capturedHeaders: Record<string, string>[] = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>)
      return { status: 500 } as Response
    }) as unknown as typeof fetch

    const payload = makePayload()

    await deliverWebhook("https://example.com/hook", payload, 3, fetchFn, noDelay, "trace-abc-123")

    expect(capturedHeaders).toHaveLength(3)
    expect(capturedHeaders.every((h) => h["X-Request-Id"] === "trace-abc-123")).toBe(true)
  })

  it("omits X-Request-Id when no correlationId is supplied", async () => {
    const capturedHeaders: Record<string, string>[] = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>)
      return { status: 200 } as Response
    }) as unknown as typeof fetch

    const payload = makePayload()

    await deliverWebhook("https://example.com/hook", payload, 2, fetchFn, noDelay)

    expect(capturedHeaders).toHaveLength(1)
    expect(capturedHeaders[0]["X-Request-Id"]).toBeUndefined()
  })

  it("records the correlationId as request_id in the delivery record", async () => {
    const fetchFn = makeFetch([{ status: 200 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay, "trace-xyz-789")

    expect(record.request_id).toBe("trace-xyz-789")
  })

  it("records request_id as null when no correlationId is supplied", async () => {
    const fetchFn = makeFetch([{ status: 503 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 1, fetchFn, noDelay)

    expect(record.request_id).toBeNull()
  })

  it("records the last HTTP status code in the delivery record", async () => {
    const fetchFn = makeFetch([{ status: 404 }, { status: 429 }, { status: 200 }])
    const payload = makePayload()

    const record = await deliverWebhook("https://example.com/hook", payload, 5, fetchFn, noDelay)

    expect(record.status).toBe("delivered")
    expect(record.last_status_code).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// buildWebhookPayload tests
// ---------------------------------------------------------------------------

describe("buildWebhookPayload", () => {
  it("constructs a valid payload with idempotency_key derived from eventType + invoiceId", () => {
    const payload = buildWebhookPayload("invoice_paid", { amount: 100 }, { invoiceId: "42" })

    expect(payload.event_type).toBe("invoice_paid")
    expect(payload.invoice_id).toBe("42")
    expect(payload.idempotency_key).toBe("invoice_paid:42")
    expect(payload.data).toEqual({ amount: 100 })
    expect(payload.timestamp).toBeDefined()
  })

  it("constructs a valid payload with idempotency_key derived from eventType + settlementId", () => {
    const payload = buildWebhookPayload("settlement_executed", {}, { settlementId: "7" })

    expect(payload.settlement_id).toBe("7")
    expect(payload.idempotency_key).toBe("settlement_executed:7")
  })

  it("builds a deterministic idempotency_key for the same event", () => {
    const p1 = buildWebhookPayload("invoice_paid", {}, { invoiceId: "5" })
    const p2 = buildWebhookPayload("invoice_paid", {}, { invoiceId: "5" })

    expect(p1.idempotency_key).toBe(p2.idempotency_key)
  })
})
