/**
 * webhook-dispatcher.ts
 *
 * Dispatches outbound webhook notifications to registered subscriber URLs
 * whenever key on-chain or application events occur (e.g. invoice created,
 * settlement executed, dispute raised).
 *
 * Design goals
 * ────────────
 * #1057 – Defensive null/undefined checks throughout; every async path is
 *          wrapped in try/catch with structured error propagation so that a
 *          single bad payload or unreachable subscriber cannot crash the
 *          process under high load.
 *
 * #1058 – All incoming webhook registration and dispatch requests are
 *          validated against typed schemas before any processing begins.
 *          Structured error responses are always returned instead of letting
 *          unhandled exceptions surface.
 *
 * #1059 – Hot-path object allocations are minimised; subscriber lookups and
 *          HTTP delivery results are batched so the event loop is not blocked
 *          on sequential awaits; per-request data (e.g. resolved subscribers)
 *          is cached within the lifecycle of a single dispatch call to avoid
 *          redundant database round-trips.
 *
 * #1060 – All public API is designed for testability: concrete I/O (HTTP
 *          fetch, DB) is injected via dependency parameters so unit tests can
 *          supply mocks without monkey-patching globals.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of delivery attempts before a webhook is marked failed. */
export const MAX_RETRIES = 3

/**
 * Delay (ms) between retry attempts.  Kept short so the test suite does not
 * time-out waiting; production callers may override via WEBHOOK_RETRY_DELAY_MS.
 */
export const DEFAULT_RETRY_DELAY_MS = 1_000

/** Hard cap on how many subscribers are notified concurrently per event. */
export const CONCURRENCY_LIMIT = 10

/** Allowed event types for subscriber registration. */
export const SUPPORTED_EVENTS = [
  "invoice.created",
  "invoice.paid",
  "invoice.cancelled",
  "settlement.proposed",
  "settlement.approved",
  "settlement.executed",
  "dispute.raised",
  "dispute.resolved",
] as const

export type WebhookEventType = (typeof SUPPORTED_EVENTS)[number]

// ─── Types ────────────────────────────────────────────────────────────────────

/** A subscriber record as stored in the database. */
export interface WebhookSubscriber {
  id: string
  url: string
  secret: string
  events: WebhookEventType[]
  createdAt: Date
  active: boolean
}

/** The envelope sent to each subscriber URL. */
export interface WebhookPayload {
  event: WebhookEventType
  /** ISO-8601 timestamp at the moment of dispatch. */
  timestamp: string
  /** Opaque event-specific data. */
  data: Record<string, unknown>
}

/** Result of a single delivery attempt to one subscriber. */
export interface DeliveryResult {
  subscriberId: string
  url: string
  success: boolean
  statusCode: number | null
  attempt: number
  error?: string
}

/** Aggregated result returned by dispatchEvent(). */
export interface DispatchResult {
  event: WebhookEventType
  subscriberCount: number
  delivered: number
  failed: number
  results: DeliveryResult[]
}

/** Structured validation error shape. */
export interface ValidationError {
  field: string
  message: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates an incoming subscriber registration request body.
 * Returns null when valid; returns a ValidationError on failure.
 *
 * #1058 – Provides meaningful, field-level error messages.
 */
export function validateSubscriberPayload(
  body: unknown,
): ValidationError | null {
  if (body === null || body === undefined || typeof body !== "object") {
    return { field: "body", message: "Request body must be a JSON object" }
  }

  const b = body as Record<string, unknown>

  if (!b.url || typeof b.url !== "string" || b.url.trim() === "") {
    return { field: "url", message: "url is required and must be a non-empty string" }
  }

  try {
    const parsed = new URL(b.url as string)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { field: "url", message: "url must use http or https protocol" }
    }
  } catch {
    return { field: "url", message: "url must be a valid URL" }
  }

  if (!b.secret || typeof b.secret !== "string" || b.secret.trim() === "") {
    return { field: "secret", message: "secret is required and must be a non-empty string" }
  }

  if (b.secret.length < 16) {
    return { field: "secret", message: "secret must be at least 16 characters" }
  }

  if (!Array.isArray(b.events) || b.events.length === 0) {
    return { field: "events", message: "events must be a non-empty array" }
  }

  for (const ev of b.events as unknown[]) {
    if (typeof ev !== "string" || !(SUPPORTED_EVENTS as readonly string[]).includes(ev)) {
      return {
        field: "events",
        message: `'${String(ev)}' is not a supported event type. Supported: ${SUPPORTED_EVENTS.join(", ")}`,
      }
    }
  }

  return null
}

/**
 * Validates an incoming webhook dispatch request.
 * Returns null when valid; returns a ValidationError on failure.
 *
 * #1058 – Schema-level validation before any I/O.
 */
export function validateDispatchPayload(body: unknown): ValidationError | null {
  if (body === null || body === undefined || typeof body !== "object") {
    return { field: "body", message: "Request body must be a JSON object" }
  }

  const b = body as Record<string, unknown>

  if (!b.event || typeof b.event !== "string") {
    return { field: "event", message: "event is required and must be a string" }
  }

  if (!(SUPPORTED_EVENTS as readonly string[]).includes(b.event)) {
    return {
      field: "event",
      message: `'${b.event}' is not a supported event type. Supported: ${SUPPORTED_EVENTS.join(", ")}`,
    }
  }

  if (b.data !== undefined && (typeof b.data !== "object" || Array.isArray(b.data) || b.data === null)) {
    return { field: "data", message: "data must be a JSON object when provided" }
  }

  return null
}

// ─── Dependency injection interfaces ──────────────────────────────────────────

/**
 * Minimal abstraction over the subscribers collection.
 * Injected so unit tests do not need a real database.
 *
 * #1059 – findByEvent returns only the fields we need for a single query,
 *          rather than loading all subscribers and filtering in memory.
 */
export interface SubscriberStore {
  findByEvent(event: WebhookEventType): Promise<WebhookSubscriber[]>
  insert(subscriber: WebhookSubscriber): Promise<void>
  findById(id: string): Promise<WebhookSubscriber | null>
  deactivate(id: string): Promise<void>
}

/**
 * Minimal abstraction over the delivery log collection.
 * #1059 – bulkInsert lets us batch all delivery results in one round-trip.
 */
export interface DeliveryLogStore {
  bulkInsert(results: DeliveryResult[]): Promise<void>
}

/**
 * Abstraction over outbound HTTP so tests can stub responses without real
 * network calls.
 */
export type HttpPost = (
  url: string,
  payload: WebhookPayload,
  secret: string,
  signal?: AbortSignal,
) => Promise<{ statusCode: number }>

// ─── Core delivery logic ──────────────────────────────────────────────────────

/**
 * Delivers a webhook payload to a single subscriber URL.
 * Retries up to MAX_RETRIES times on transient failures (5xx / network error).
 *
 * #1057 – All awaited I/O is wrapped in try/catch; failures are returned as
 *          DeliveryResult rather than thrown, so one bad subscriber does not
 *          abort the batch.
 *
 * #1059 – Uses an AbortController per attempt to cap request time and free
 *          resources promptly; avoids allocating a new payload copy per retry
 *          by reusing the same reference.
 */
export async function deliverToSubscriber(
  subscriber: WebhookSubscriber,
  payload: WebhookPayload,
  httpPost: HttpPost,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<DeliveryResult> {
  // Guard: skip inactive subscribers without any network I/O.
  if (!subscriber || !subscriber.active) {
    return {
      subscriberId: subscriber?.id ?? "unknown",
      url: subscriber?.url ?? "",
      success: false,
      statusCode: null,
      attempt: 0,
      error: "Subscriber is inactive",
    }
  }

  let lastError: string | undefined
  let lastStatusCode: number | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // #1057 – race condition guard: abort the HTTP call after 10 s to prevent
    //          a stalled subscriber from occupying the event loop indefinitely.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const { statusCode } = await httpPost(
        subscriber.url,
        payload,
        subscriber.secret,
        controller.signal,
      )
      lastStatusCode = statusCode

      if (statusCode >= 200 && statusCode < 300) {
        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          success: true,
          statusCode,
          attempt,
        }
      }

      // 4xx errors are not transient — do not retry.
      if (statusCode >= 400 && statusCode < 500) {
        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          success: false,
          statusCode,
          attempt,
          error: `Subscriber returned ${statusCode}; not retrying client error`,
        }
      }

      lastError = `Subscriber returned ${statusCode}`
    } catch (err: unknown) {
      // #1057 – absorb network errors (timeout, DNS, ECONNREFUSED) and retry.
      lastError = err instanceof Error ? err.message : String(err)
      lastStatusCode = null
    } finally {
      clearTimeout(timeout)
    }

    if (attempt < MAX_RETRIES) {
      // #1059 – linear back-off reuses the same delay value; no extra allocation.
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * attempt))
    }
  }

  return {
    subscriberId: subscriber.id,
    url: subscriber.url,
    success: false,
    statusCode: lastStatusCode,
    attempt: MAX_RETRIES,
    error: lastError ?? "Max retries exceeded",
  }
}

// ─── Batch dispatch ───────────────────────────────────────────────────────────

/**
 * Dispatches a webhook event to all active subscribers registered for it.
 *
 * #1057 – Null/undefined guards on every external value; individual delivery
 *          failures never propagate as uncaught rejections.
 *
 * #1058 – Validates the event and data shape before touching the database.
 *
 * #1059 – Subscribers are fetched once and cached in a local variable for the
 *          entire dispatch lifecycle.  Deliveries run in parallel batches of
 *          CONCURRENCY_LIMIT instead of one-by-one, cutting wall-clock time
 *          significantly under load.  Delivery results are written to the log
 *          in a single bulk insert rather than N individual writes.
 */
export async function dispatchEvent(
  event: WebhookEventType,
  data: Record<string, unknown>,
  store: SubscriberStore,
  logStore: DeliveryLogStore,
  httpPost: HttpPost,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<DispatchResult> {
  // #1058 – Validate inputs before any I/O.
  const validationError = validateDispatchPayload({ event, data })
  if (validationError) {
    throw Object.assign(
      new Error(`Webhook dispatch validation failed: ${validationError.message}`),
      { status: 400, field: validationError.field },
    )
  }

  // #1059 – Single DB query; result is reused throughout.
  let subscribers: WebhookSubscriber[]
  try {
    subscribers = await store.findByEvent(event)
  } catch (err: unknown) {
    // #1057 – DB failure should not crash the caller; surface it as a 503.
    throw Object.assign(
      new Error(
        `Failed to load webhook subscribers: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { status: 503 },
    )
  }

  // Filter to active subscribers only — the store query may return inactive
  // ones depending on implementation.
  const activeSubscribers = (subscribers ?? []).filter((s) => s?.active === true)

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    // #1059 – shallow copy is intentional: avoids mutating the caller's object
    //          while not deep-cloning potentially large data trees.
    data: { ...data },
  }

  const allResults: DeliveryResult[] = []

  // #1059 – Process in CONCURRENCY_LIMIT-sized batches to bound parallelism.
  for (let i = 0; i < activeSubscribers.length; i += CONCURRENCY_LIMIT) {
    const batch = activeSubscribers.slice(i, i + CONCURRENCY_LIMIT)

    // #1057 – Promise.allSettled guarantees all results are collected even if
    //          some deliveries reject unexpectedly.
    const settled = await Promise.allSettled(
      batch.map((subscriber) =>
        deliverToSubscriber(subscriber, payload, httpPost, retryDelayMs),
      ),
    )

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        allResults.push(outcome.value)
      } else {
        // #1057 – Catch any unexpected rejection from deliverToSubscriber.
        allResults.push({
          subscriberId: "unknown",
          url: "",
          success: false,
          statusCode: null,
          attempt: 0,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
    }
  }

  // #1059 – One bulk write instead of N individual inserts.
  if (allResults.length > 0) {
    try {
      await logStore.bulkInsert(allResults)
    } catch (logErr: unknown) {
      // #1057 – Log failures must not block returning results to the caller.
      console.error(
        "[webhook-dispatcher] delivery log insert failed:",
        logErr instanceof Error ? logErr.message : logErr,
      )
    }
  }

  const delivered = allResults.filter((r) => r.success).length
  const failed = allResults.length - delivered

  if (allResults.length > 0) {
    console.log(
      `[webhook-dispatcher] event=${event} subscribers=${activeSubscribers.length} ` +
        `delivered=${delivered} failed=${failed}`,
    )
  }

  return {
    event,
    subscriberCount: activeSubscribers.length,
    delivered,
    failed,
    results: allResults,
  }
}

// ─── Subscriber registration ──────────────────────────────────────────────────

/**
 * Registers a new webhook subscriber.
 *
 * #1057 – ID generation and date construction are guarded; store failures are
 *          wrapped with a meaningful status code.
 *
 * #1058 – Validates the full registration payload before any database write.
 */
export async function registerSubscriber(
  body: unknown,
  store: SubscriberStore,
  generateId: () => string = defaultGenerateId,
): Promise<WebhookSubscriber> {
  const validationError = validateSubscriberPayload(body)
  if (validationError) {
    throw Object.assign(
      new Error(`Subscriber registration validation failed: ${validationError.message}`),
      { status: 400, field: validationError.field },
    )
  }

  const b = body as { url: string; secret: string; events: WebhookEventType[] }

  const subscriber: WebhookSubscriber = {
    id: generateId(),
    url: b.url.trim(),
    secret: b.secret,
    events: b.events as WebhookEventType[],
    createdAt: new Date(),
    active: true,
  }

  try {
    await store.insert(subscriber)
  } catch (err: unknown) {
    throw Object.assign(
      new Error(
        `Failed to register subscriber: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { status: 503 },
    )
  }

  return subscriber
}

/**
 * Deactivates an existing subscriber by ID.
 *
 * #1057 – Validates the ID and guards against missing records.
 * #1058 – Returns a 404 when the subscriber does not exist.
 */
export async function deactivateSubscriber(
  id: string | undefined | null,
  store: SubscriberStore,
): Promise<{ id: string; active: false }> {
  if (!id || typeof id !== "string" || id.trim() === "") {
    throw Object.assign(new Error("id is required and must be a non-empty string"), {
      status: 400,
    })
  }

  let existing: WebhookSubscriber | null
  try {
    existing = await store.findById(id)
  } catch (err: unknown) {
    throw Object.assign(
      new Error(
        `Failed to look up subscriber: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { status: 503 },
    )
  }

  if (!existing) {
    throw Object.assign(new Error(`Subscriber '${id}' not found`), { status: 404 })
  }

  try {
    await store.deactivate(id)
  } catch (err: unknown) {
    throw Object.assign(
      new Error(
        `Failed to deactivate subscriber: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { status: 503 },
    )
  }

  return { id, active: false }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Default ID generator — uses crypto.randomUUID() when available (Node ≥ 15),
 * otherwise falls back to a timestamp+random string.
 *
 * #1057 – Falls back gracefully if the crypto API is unavailable.
 */
export function defaultGenerateId(): string {
  try {
    // Available in Node 15+; guarded so the module loads in older runtimes.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
  } catch {
    // intentionally ignored — fall through to the fallback below
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
