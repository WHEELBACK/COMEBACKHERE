/**
 * webhook-dispatcher.test.ts
 *
 * Unit and integration tests for the webhook-dispatcher service module.
 * Covers issues #1057 (edge-case safety), #1058 (validation), #1059 (perf
 * contracts), and #1060 (test coverage mandate).
 *
 * Test framework: vitest  (matches the project's existing test setup)
 * No real HTTP calls or database connections are made.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest"
import {
  validateSubscriberPayload,
  validateDispatchPayload,
  deliverToSubscriber,
  dispatchEvent,
  registerSubscriber,
  deactivateSubscriber,
  defaultGenerateId,
  SUPPORTED_EVENTS,
  MAX_RETRIES,
  CONCURRENCY_LIMIT,
  type WebhookSubscriber,
  type WebhookPayload,
  type SubscriberStore,
  type DeliveryLogStore,
  type HttpPost,
  type WebhookEventType,
} from "../services/webhook-dispatcher.js"

// ─── Test fixtures ────────────────────────────────────────────────────────────

const VALID_URL = "https://example.com/hooks"
const VALID_SECRET = "supersecretkey1234"
const VALID_EVENTS: WebhookEventType[] = ["invoice.created", "settlement.executed"]

function makeSubscriber(overrides: Partial<WebhookSubscriber> = {}): WebhookSubscriber {
  return {
    id: "sub-1",
    url: VALID_URL,
    secret: VALID_SECRET,
    events: VALID_EVENTS,
    createdAt: new Date(),
    active: true,
    ...overrides,
  }
}

function makeStore(
  overrides: Partial<{
    findByEvent: SubscriberStore["findByEvent"]
    insert: SubscriberStore["insert"]
    findById: SubscriberStore["findById"]
    deactivate: SubscriberStore["deactivate"]
  }> = {},
): SubscriberStore {
  return {
    findByEvent: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    deactivate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeLogStore(overrides: Partial<DeliveryLogStore> = {}): DeliveryLogStore {
  return {
    bulkInsert: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeHttpPost(statusCode = 200): MockedFunction<HttpPost> {
  return vi.fn().mockResolvedValue({ statusCode })
}

const VALID_DATA = { invoice_id: "42", amount: "1000000" }

// ─── validateSubscriberPayload ────────────────────────────────────────────────

describe("validateSubscriberPayload", () => {
  it("returns null for a fully valid payload", () => {
    expect(
      validateSubscriberPayload({ url: VALID_URL, secret: VALID_SECRET, events: VALID_EVENTS }),
    ).toBeNull()
  })

  it("returns error when body is null", () => {
    const err = validateSubscriberPayload(null)
    expect(err).not.toBeNull()
    expect(err?.field).toBe("body")
  })

  it("returns error when body is not an object", () => {
    expect(validateSubscriberPayload("string")).not.toBeNull()
    expect(validateSubscriberPayload(42)).not.toBeNull()
  })

  it("returns error when url is missing", () => {
    const err = validateSubscriberPayload({ secret: VALID_SECRET, events: VALID_EVENTS })
    expect(err?.field).toBe("url")
  })

  it("returns error when url is an empty string", () => {
    const err = validateSubscriberPayload({ url: "  ", secret: VALID_SECRET, events: VALID_EVENTS })
    expect(err?.field).toBe("url")
  })

  it("returns error when url is not a valid URL", () => {
    const err = validateSubscriberPayload({
      url: "not-a-url",
      secret: VALID_SECRET,
      events: VALID_EVENTS,
    })
    expect(err?.field).toBe("url")
  })

  it("returns error when url uses an unsupported protocol", () => {
    const err = validateSubscriberPayload({
      url: "ftp://example.com/hook",
      secret: VALID_SECRET,
      events: VALID_EVENTS,
    })
    expect(err?.field).toBe("url")
  })

  it("accepts http:// as a valid protocol", () => {
    expect(
      validateSubscriberPayload({
        url: "http://localhost:3000/hook",
        secret: VALID_SECRET,
        events: VALID_EVENTS,
      }),
    ).toBeNull()
  })

  it("returns error when secret is missing", () => {
    const err = validateSubscriberPayload({ url: VALID_URL, events: VALID_EVENTS })
    expect(err?.field).toBe("secret")
  })

  it("returns error when secret is too short (< 16 chars)", () => {
    const err = validateSubscriberPayload({
      url: VALID_URL,
      secret: "tooshort",
      events: VALID_EVENTS,
    })
    expect(err?.field).toBe("secret")
    expect(err?.message).toMatch(/16/)
  })

  it("returns error when events is not an array", () => {
    const err = validateSubscriberPayload({ url: VALID_URL, secret: VALID_SECRET, events: "all" })
    expect(err?.field).toBe("events")
  })

  it("returns error when events array is empty", () => {
    const err = validateSubscriberPayload({ url: VALID_URL, secret: VALID_SECRET, events: [] })
    expect(err?.field).toBe("events")
  })

  it("returns error when events contains an unsupported value", () => {
    const err = validateSubscriberPayload({
      url: VALID_URL,
      secret: VALID_SECRET,
      events: ["invoice.created", "unknown.event"],
    })
    expect(err?.field).toBe("events")
    expect(err?.message).toMatch(/unknown\.event/)
  })

  it("accepts all supported event types", () => {
    expect(
      validateSubscriberPayload({ url: VALID_URL, secret: VALID_SECRET, events: [...SUPPORTED_EVENTS] }),
    ).toBeNull()
  })
})

// ─── validateDispatchPayload ──────────────────────────────────────────────────

describe("validateDispatchPayload", () => {
  it("returns null for a valid event without data", () => {
    expect(validateDispatchPayload({ event: "invoice.created" })).toBeNull()
  })

  it("returns null for a valid event with data", () => {
    expect(validateDispatchPayload({ event: "settlement.executed", data: { id: 1 } })).toBeNull()
  })

  it("returns error when body is null", () => {
    expect(validateDispatchPayload(null)?.field).toBe("body")
  })

  it("returns error when event is missing", () => {
    expect(validateDispatchPayload({})?.field).toBe("event")
  })

  it("returns error when event is not a string", () => {
    expect(validateDispatchPayload({ event: 42 })?.field).toBe("event")
  })

  it("returns error when event is not a supported type", () => {
    const err = validateDispatchPayload({ event: "foo.bar" })
    expect(err?.field).toBe("event")
    expect(err?.message).toMatch(/foo\.bar/)
  })

  it("returns error when data is an array", () => {
    expect(validateDispatchPayload({ event: "invoice.created", data: [] })?.field).toBe("data")
  })

  it("returns error when data is a primitive", () => {
    expect(validateDispatchPayload({ event: "invoice.created", data: "string" })?.field).toBe("data")
  })
})

// ─── deliverToSubscriber ──────────────────────────────────────────────────────

describe("deliverToSubscriber", () => {
  const payload: WebhookPayload = {
    event: "invoice.created",
    timestamp: new Date().toISOString(),
    data: VALID_DATA,
  }

  it("returns success on 200 response", async () => {
    const http = makeHttpPost(200)
    const result = await deliverToSubscriber(makeSubscriber(), payload, http, 0)
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.attempt).toBe(1)
    expect(http).toHaveBeenCalledOnce()
  })

  it("returns success on 201 response", async () => {
    const result = await deliverToSubscriber(makeSubscriber(), payload, makeHttpPost(201), 0)
    expect(result.success).toBe(true)
  })

  it("does not retry on 4xx response", async () => {
    const http = makeHttpPost(400)
    const result = await deliverToSubscriber(makeSubscriber(), payload, http, 0)
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(400)
    // Should stop after first attempt for client errors
    expect(http).toHaveBeenCalledOnce()
    expect(result.error).toMatch(/400/)
  })

  it("retries up to MAX_RETRIES on 5xx responses and returns failure", async () => {
    const http = makeHttpPost(500)
    const result = await deliverToSubscriber(makeSubscriber(), payload, http, 0)
    expect(result.success).toBe(false)
    expect(http).toHaveBeenCalledTimes(MAX_RETRIES)
    expect(result.attempt).toBe(MAX_RETRIES)
  })

  it("retries and succeeds on the second attempt", async () => {
    let calls = 0
    const http: HttpPost = vi.fn().mockImplementation(async () => {
      calls++
      return { statusCode: calls === 1 ? 503 : 200 }
    })
    const result = await deliverToSubscriber(makeSubscriber(), payload, http, 0)
    expect(result.success).toBe(true)
    expect(result.attempt).toBe(2)
  })

  it("handles network errors (thrown exceptions) and retries", async () => {
    const http: HttpPost = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await deliverToSubscriber(makeSubscriber(), payload, http, 0)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ECONNREFUSED/)
    expect((http as MockedFunction<HttpPost>)).toHaveBeenCalledTimes(MAX_RETRIES)
  })

  it("returns failure without calling http for an inactive subscriber", async () => {
    const http = makeHttpPost(200)
    const result = await deliverToSubscriber(makeSubscriber({ active: false }), payload, http, 0)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/inactive/i)
    expect(http).not.toHaveBeenCalled()
  })

  // #1057 – null subscriber guard
  it("returns failure gracefully when subscriber is null-ish", async () => {
    const http = makeHttpPost(200)
    const result = await deliverToSubscriber(null as unknown as WebhookSubscriber, payload, http, 0)
    expect(result.success).toBe(false)
  })
})

// ─── dispatchEvent ────────────────────────────────────────────────────────────

describe("dispatchEvent", () => {
  it("dispatches to all active subscribers and returns aggregated results", async () => {
    const sub1 = makeSubscriber({ id: "s1" })
    const sub2 = makeSubscriber({ id: "s2" })
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue([sub1, sub2]) })
    const logStore = makeLogStore()
    const http = makeHttpPost(200)

    const result = await dispatchEvent("invoice.created", VALID_DATA, store, logStore, http, 0)

    expect(result.subscriberCount).toBe(2)
    expect(result.delivered).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.results).toHaveLength(2)
  })

  it("skips inactive subscribers", async () => {
    const active = makeSubscriber({ id: "active" })
    const inactive = makeSubscriber({ id: "inactive", active: false })
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue([active, inactive]) })
    const http = makeHttpPost(200)

    const result = await dispatchEvent(
      "invoice.created",
      VALID_DATA,
      store,
      makeLogStore(),
      http,
      0,
    )

    expect(result.subscriberCount).toBe(1)
    expect(result.delivered).toBe(1)
  })

  it("counts failed deliveries correctly", async () => {
    const sub = makeSubscriber()
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue([sub]) })
    const http = makeHttpPost(500)

    const result = await dispatchEvent("invoice.created", VALID_DATA, store, makeLogStore(), http, 0)

    expect(result.delivered).toBe(0)
    expect(result.failed).toBe(1)
  })

  it("returns empty result when there are no subscribers", async () => {
    const result = await dispatchEvent(
      "invoice.created",
      VALID_DATA,
      makeStore(),
      makeLogStore(),
      makeHttpPost(),
      0,
    )
    expect(result.subscriberCount).toBe(0)
    expect(result.delivered).toBe(0)
    expect(result.results).toHaveLength(0)
  })

  // #1058 – validation
  it("throws 400 when event is invalid", async () => {
    await expect(
      dispatchEvent(
        "not.a.real.event" as WebhookEventType,
        VALID_DATA,
        makeStore(),
        makeLogStore(),
        makeHttpPost(),
        0,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  // #1057 – DB failure propagates as 503
  it("throws 503 when the subscriber store rejects", async () => {
    const store = makeStore({
      findByEvent: vi.fn().mockRejectedValue(new Error("DB timeout")),
    })
    await expect(
      dispatchEvent("invoice.created", VALID_DATA, store, makeLogStore(), makeHttpPost(), 0),
    ).rejects.toMatchObject({ status: 503 })
  })

  // #1057 – log store failure does not abort dispatch
  it("still returns results when the delivery log insert fails", async () => {
    const sub = makeSubscriber()
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue([sub]) })
    const logStore: DeliveryLogStore = {
      bulkInsert: vi.fn().mockRejectedValue(new Error("log DB down")),
    }
    const result = await dispatchEvent("invoice.created", VALID_DATA, store, logStore, makeHttpPost(200), 0)
    expect(result.delivered).toBe(1)
  })

  // #1059 – batch size contracts
  it(`processes subscribers in batches of at most ${CONCURRENCY_LIMIT}`, async () => {
    const subscribers = Array.from({ length: CONCURRENCY_LIMIT + 2 }, (_, i) =>
      makeSubscriber({ id: `sub-${i}` }),
    )
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue(subscribers) })

    // Track concurrent in-flight count.
    let concurrent = 0
    let maxConcurrent = 0
    const http: HttpPost = vi.fn().mockImplementation(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return { statusCode: 200 }
    })

    const result = await dispatchEvent("invoice.created", VALID_DATA, store, makeLogStore(), http, 0)

    expect(result.delivered).toBe(CONCURRENCY_LIMIT + 2)
    expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENCY_LIMIT)
  })

  // #1059 – single DB query per dispatch
  it("calls findByEvent exactly once per dispatch regardless of subscriber count", async () => {
    const findByEvent = vi.fn().mockResolvedValue([makeSubscriber({ id: "s1" }), makeSubscriber({ id: "s2" })])
    const store = makeStore({ findByEvent })

    await dispatchEvent("invoice.created", VALID_DATA, store, makeLogStore(), makeHttpPost(200), 0)

    expect(findByEvent).toHaveBeenCalledOnce()
  })

  // #1059 – single bulk insert
  it("calls bulkInsert exactly once with all results", async () => {
    const subs = [makeSubscriber({ id: "s1" }), makeSubscriber({ id: "s2" })]
    const store = makeStore({ findByEvent: vi.fn().mockResolvedValue(subs) })
    const bulkInsert = vi.fn().mockResolvedValue(undefined)
    const logStore: DeliveryLogStore = { bulkInsert }

    await dispatchEvent("invoice.created", VALID_DATA, store, logStore, makeHttpPost(200), 0)

    expect(bulkInsert).toHaveBeenCalledOnce()
    const [insertedResults] = bulkInsert.mock.calls[0] as [ReturnType<typeof dispatchEvent>["results"]]
    expect(insertedResults).toHaveLength(2)
  })
})

// ─── registerSubscriber ───────────────────────────────────────────────────────

describe("registerSubscriber", () => {
  const VALID_BODY = { url: VALID_URL, secret: VALID_SECRET, events: VALID_EVENTS }

  it("inserts and returns a new active subscriber", async () => {
    const insert = vi.fn().mockResolvedValue(undefined)
    const store = makeStore({ insert })
    const idGen = vi.fn().mockReturnValue("generated-id")

    const result = await registerSubscriber(VALID_BODY, store, idGen)

    expect(result.id).toBe("generated-id")
    expect(result.active).toBe(true)
    expect(result.url).toBe(VALID_URL)
    expect(insert).toHaveBeenCalledOnce()
  })

  it("throws 400 when payload validation fails", async () => {
    const store = makeStore()
    await expect(registerSubscriber({ url: "bad", secret: VALID_SECRET, events: [] }, store)).rejects.toMatchObject({
      status: 400,
    })
  })

  it("throws 503 when the store insert fails", async () => {
    const store = makeStore({ insert: vi.fn().mockRejectedValue(new Error("DB error")) })
    await expect(registerSubscriber(VALID_BODY, store)).rejects.toMatchObject({ status: 503 })
  })

  it("trims whitespace from url before storing", async () => {
    const insert = vi.fn().mockResolvedValue(undefined)
    const store = makeStore({ insert })
    const result = await registerSubscriber(
      { url: `  ${VALID_URL}  `, secret: VALID_SECRET, events: VALID_EVENTS },
      store,
    )
    expect(result.url).toBe(VALID_URL)
  })
})

// ─── deactivateSubscriber ─────────────────────────────────────────────────────

describe("deactivateSubscriber", () => {
  it("deactivates an existing subscriber and returns { id, active: false }", async () => {
    const sub = makeSubscriber({ id: "sub-1" })
    const deactivate = vi.fn().mockResolvedValue(undefined)
    const store = makeStore({ findById: vi.fn().mockResolvedValue(sub), deactivate })

    const result = await deactivateSubscriber("sub-1", store)

    expect(result).toEqual({ id: "sub-1", active: false })
    expect(deactivate).toHaveBeenCalledWith("sub-1")
  })

  it("throws 400 when id is empty string", async () => {
    await expect(deactivateSubscriber("", makeStore())).rejects.toMatchObject({ status: 400 })
  })

  it("throws 400 when id is null", async () => {
    await expect(deactivateSubscriber(null, makeStore())).rejects.toMatchObject({ status: 400 })
  })

  it("throws 400 when id is undefined", async () => {
    await expect(deactivateSubscriber(undefined, makeStore())).rejects.toMatchObject({ status: 400 })
  })

  it("throws 404 when subscriber does not exist", async () => {
    const store = makeStore({ findById: vi.fn().mockResolvedValue(null) })
    await expect(deactivateSubscriber("missing-id", store)).rejects.toMatchObject({ status: 404 })
  })

  it("throws 503 when findById rejects", async () => {
    const store = makeStore({ findById: vi.fn().mockRejectedValue(new Error("DB error")) })
    await expect(deactivateSubscriber("sub-1", store)).rejects.toMatchObject({ status: 503 })
  })

  it("throws 503 when deactivate store call rejects", async () => {
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(makeSubscriber()),
      deactivate: vi.fn().mockRejectedValue(new Error("write failed")),
    })
    await expect(deactivateSubscriber("sub-1", store)).rejects.toMatchObject({ status: 503 })
  })
})

// ─── defaultGenerateId ────────────────────────────────────────────────────────

describe("defaultGenerateId", () => {
  it("returns a non-empty string", () => {
    const id = defaultGenerateId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  it("returns unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => defaultGenerateId()))
    expect(ids.size).toBe(50)
  })
})

// ─── Integration: register → dispatch → deactivate ───────────────────────────

describe("Integration: full webhook lifecycle", () => {
  it("registers a subscriber, dispatches an event, then deactivates", async () => {
    // In-memory store simulation
    const subscribers: WebhookSubscriber[] = []
    const logs: ReturnType<typeof dispatchEvent>["results"] = []

    const store: SubscriberStore = {
      findByEvent: vi.fn().mockImplementation(async (event: WebhookEventType) =>
        subscribers.filter((s) => s.active && s.events.includes(event)),
      ),
      insert: vi.fn().mockImplementation(async (s: WebhookSubscriber) => {
        subscribers.push(s)
      }),
      findById: vi.fn().mockImplementation(async (id: string) =>
        subscribers.find((s) => s.id === id) ?? null,
      ),
      deactivate: vi.fn().mockImplementation(async (id: string) => {
        const s = subscribers.find((sub) => sub.id === id)
        if (s) s.active = false
      }),
    }

    const logStore: DeliveryLogStore = {
      bulkInsert: vi.fn().mockImplementation(async (results) => {
        logs.push(...results)
      }),
    }

    const http = makeHttpPost(200)

    // 1. Register
    const sub = await registerSubscriber(
      { url: VALID_URL, secret: VALID_SECRET, events: ["invoice.created"] },
      store,
    )
    expect(sub.active).toBe(true)
    expect(subscribers).toHaveLength(1)

    // 2. Dispatch — should reach the subscriber
    const dispatchResult = await dispatchEvent(
      "invoice.created",
      { invoice_id: "1" },
      store,
      logStore,
      http,
      0,
    )
    expect(dispatchResult.delivered).toBe(1)
    expect(http).toHaveBeenCalledOnce()
    expect(logs).toHaveLength(1)

    // 3. Dispatch a different event — subscriber is not registered for it
    const otherResult = await dispatchEvent(
      "dispute.raised",
      { settlement_id: "5" },
      store,
      logStore,
      makeHttpPost(200),
      0,
    )
    expect(otherResult.subscriberCount).toBe(0)
    expect(otherResult.delivered).toBe(0)

    // 4. Deactivate
    const deactivateResult = await deactivateSubscriber(sub.id, store)
    expect(deactivateResult.active).toBe(false)

    // 5. Dispatch again — deactivated subscriber should be skipped
    const afterDeactivate = await dispatchEvent(
      "invoice.created",
      { invoice_id: "2" },
      store,
      logStore,
      makeHttpPost(200),
      0,
    )
    expect(afterDeactivate.subscriberCount).toBe(0)
    expect(afterDeactivate.delivered).toBe(0)
  })

  it("handles concurrent dispatches to multiple subscribers without data corruption", async () => {
    const count = 5
    const received: string[] = []
    const subscribers = Array.from({ length: count }, (_, i) =>
      makeSubscriber({ id: `sub-${i}` }),
    )

    const store: SubscriberStore = {
      findByEvent: vi.fn().mockResolvedValue(subscribers),
      insert: vi.fn(),
      findById: vi.fn(),
      deactivate: vi.fn(),
    }

    const http: HttpPost = vi.fn().mockImplementation(async (_, payload) => {
      received.push(payload.event)
      return { statusCode: 200 }
    })

    // Fire 3 dispatches concurrently
    const results = await Promise.all([
      dispatchEvent("invoice.created", { n: 1 }, store, makeLogStore(), http, 0),
      dispatchEvent("invoice.created", { n: 2 }, store, makeLogStore(), http, 0),
      dispatchEvent("invoice.created", { n: 3 }, store, makeLogStore(), http, 0),
    ])

    // Each dispatch should have reached all 5 subscribers
    for (const r of results) {
      expect(r.delivered).toBe(count)
    }
    expect(received).toHaveLength(count * 3)
  })

  it("high-load: 100 subscribers with partial failures returns correct counts", async () => {
    const total = 100
    const failEvery = 5 // every 5th subscriber will return 500
    const subscribers = Array.from({ length: total }, (_, i) =>
      makeSubscriber({ id: `s${i}` }),
    )

    const store: SubscriberStore = {
      findByEvent: vi.fn().mockResolvedValue(subscribers),
      insert: vi.fn(),
      findById: vi.fn(),
      deactivate: vi.fn(),
    }

    let callIndex = 0
    const http: HttpPost = vi.fn().mockImplementation(async () => {
      callIndex++
      return { statusCode: callIndex % failEvery === 0 ? 500 : 200 }
    })

    const result = await dispatchEvent(
      "settlement.executed",
      { settlement_id: "99" },
      store,
      makeLogStore(),
      http,
      0,
    )

    expect(result.subscriberCount).toBe(total)
    expect(result.results).toHaveLength(total)
    // All results should be accounted for
    expect(result.delivered + result.failed).toBe(total)
  })
})
