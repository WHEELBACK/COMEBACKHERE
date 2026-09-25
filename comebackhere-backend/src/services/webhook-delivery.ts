/**
 * Webhook delivery service — Issue #217
 *
 * Delivers webhook events to merchant endpoints with exponential backoff retry
 * and a maximum attempt cap. A terminal "failed" status is recorded once all
 * retries are exhausted.
 *
 * Idempotency: every payload includes an `idempotency_key` so the merchant can
 * detect duplicate deliveries caused by retries.
 *
 * Correlation: when a correlation ID is supplied (e.g. `res.locals.requestId`
 * from the correlationId middleware, issue #224), it is forwarded as an
 * `X-Request-Id` header on every delivery attempt so the merchant can trace a
 * single event across both the backend and their own logs.
 */

import { connectMongo } from "../db/mongo.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus =
  | "delivered"
  | "failed"
  | "pending"

export interface WebhookPayload {
  event_type: string
  invoice_id?: string
  settlement_id?: string
  /** Stable per-event key. Set once and preserved across retries. */
  idempotency_key: string
  timestamp: string
  data: Record<string, unknown>
}

export interface WebhookDeliveryRecord {
  idempotency_key: string
  endpoint: string
  payload: WebhookPayload
  status: WebhookDeliveryStatus
  attempts: number
  last_attempt_at: string | null
  last_status_code: number | null
  last_error: string | null
  /** Correlation ID forwarded as `X-Request-Id`, or null when none was supplied. */
  request_id: string | null
}

// ---------------------------------------------------------------------------
// Default retry config
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ATTEMPTS = 5
/** Base delay in ms for exponential backoff: delay = BASE_DELAY_MS * 2^attempt */
export const BASE_DELAY_MS = 1_000

// ---------------------------------------------------------------------------
// Internal: single HTTP post with a timeout
// ---------------------------------------------------------------------------

/**
 * Performs a single HTTP POST. Returns the HTTP status code on success
 * or throws on network error / timeout.
 *
 * Swappable via the `fetchFn` parameter so tests can inject a fake.
 *
 * @param correlationId Correlation ID forwarded as the `X-Request-Id` header
 *                      (e.g. `res.locals.requestId`). Omitted when undefined.
 */
export async function postWebhook(
  endpoint: string,
  payload: WebhookPayload,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
  correlationId?: string,
): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Idempotency-Key": payload.idempotency_key,
  }
  if (correlationId && correlationId.trim() !== "") {
    headers["X-Request-Id"] = correlationId
  }

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return response.status
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Internal: delay helper (injectable for tests)
// ---------------------------------------------------------------------------

export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Core: deliver with retry
// ---------------------------------------------------------------------------

/**
 * Delivers `payload` to `endpoint` with exponential backoff.
 *
 * @param endpoint      Merchant HTTPS URL to POST to.
 * @param payload       Webhook payload (must have `idempotency_key` set).
 * @param maxAttempts   Hard cap on delivery attempts (default: 5).
 * @param fetchFn       Fetch implementation (injectable for tests).
 * @param delayFn       Sleep implementation (injectable for tests).
 * @param correlationId Correlation ID forwarded as the `X-Request-Id` header on
 *                      every attempt (e.g. `res.locals.requestId`). Preserved
 *                      across retries and recorded on the delivery record.
 * @returns             A delivery record describing the final outcome.
 */
export async function deliverWebhook(
  endpoint: string,
  payload: WebhookPayload,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchFn: typeof fetch = fetch,
  delayFn: (ms: number) => Promise<void> = defaultDelay,
  correlationId?: string,
): Promise<WebhookDeliveryRecord> {
  const { signal, startAttempt = 0, onAttempt } = options
  const record: WebhookDeliveryRecord = {
    idempotency_key: payload.idempotency_key,
    endpoint,
    payload,
    status: "pending",
    attempts: startAttempt,
    last_attempt_at: null,
    last_status_code: null,
    last_error: null,
    request_id: correlationId ?? null,
  }

  for (let attempt = startAttempt; attempt < maxAttempts; attempt++) {
    // Shutting down — leave the record "pending" so the caller can persist it.
    if (signal?.aborted) return record

    onAttempt?.(attempt + 1)
    record.attempts = attempt + 1
    record.last_attempt_at = new Date().toISOString()

    try {
      const statusCode = await postWebhook(endpoint, payload, fetchFn, undefined, correlationId)
      record.last_status_code = statusCode

      if (statusCode >= 200 && statusCode < 300) {
        record.status = "delivered"
        return record
      }

      // Non-2xx response — treat as a retryable failure
      record.last_error = `HTTP ${statusCode}`
    } catch (err) {
      record.last_error = err instanceof Error ? err.message : String(err)
      record.last_status_code = null
    }

    // Apply exponential backoff before the next attempt (skip after last attempt)
    const isLastAttempt = attempt === maxAttempts - 1
    if (!isLastAttempt) {
      const backoffMs = BASE_DELAY_MS * Math.pow(2, attempt)
      await delayFn(backoffMs)
    }
  }

  // All attempts exhausted — record terminal failure
  record.status = "failed"
  console.error(
    `[webhook] delivery failed after ${record.attempts} attempt(s) ` +
    `key=${record.idempotency_key} requestId=${record.request_id ?? "-"} ` +
    `endpoint=${endpoint} last_error=${record.last_error}`,
  )
  return record
}

// ---------------------------------------------------------------------------
// Convenience: build a payload with a generated idempotency key
// ---------------------------------------------------------------------------

/**
 * Creates a WebhookPayload and generates an idempotency key deterministically
 * from the event type and invoice/settlement id so the same key is reused if
 * the payload is reconstructed from the same event.
 */
export function buildWebhookPayload(
  eventType: string,
  data: Record<string, unknown>,
  options?: { invoiceId?: string; settlementId?: string },
): WebhookPayload {
  const id = options?.invoiceId ?? options?.settlementId ?? crypto.randomUUID()
  const idempotency_key = `${eventType}:${id}`

  return {
    event_type: eventType,
    invoice_id: options?.invoiceId,
    settlement_id: options?.settlementId,
    idempotency_key,
    timestamp: new Date().toISOString(),
    data,
  }
}

// ---------------------------------------------------------------------------
// Delivery queue with graceful drain
// ---------------------------------------------------------------------------

/** A delivery that has not finished yet, in a form that can be persisted. */
export interface WebhookDeliveryJob {
  endpoint: string
  payload: WebhookPayload
  /** Attempts already made; a resumed job continues from here. */
  attempts: number
}

/** Durable storage for deliveries that did not finish before shutdown. */
export interface PendingDeliveryStore {
  save(jobs: WebhookDeliveryJob[]): Promise<void>
  /** Returns every stored job and removes it from the store. */
  takeAll(): Promise<WebhookDeliveryJob[]>
}

const PENDING_DELIVERIES_COLLECTION = "webhook_pending_deliveries"

/** MongoDB-backed store, keyed by idempotency_key so re-saving is harmless. */
export function createMongoPendingDeliveryStore(): PendingDeliveryStore {
  return {
    async save(jobs) {
      const database = await connectMongo()
      const collection = database.collection<WebhookDeliveryJob & { _id: string }>(
        PENDING_DELIVERIES_COLLECTION,
      )
      await Promise.all(
        jobs.map((job) =>
          collection.replaceOne(
            { _id: job.payload.idempotency_key },
            job,
            { upsert: true },
          ),
        ),
      )
    },
    async takeAll() {
      const database = await connectMongo()
      const collection = database.collection<WebhookDeliveryJob & { _id: string }>(
        PENDING_DELIVERIES_COLLECTION,
      )
      const docs = await collection.find().toArray()
      if (docs.length > 0) {
        await collection.deleteMany({ _id: { $in: docs.map((d) => d._id) } })
      }
      return docs.map(({ endpoint, payload, attempts }) => ({ endpoint, payload, attempts }))
    },
  }
}

/** Sleeps for `ms`, resolving early if `signal` aborts. */
function abortableDelay(
  delayFn: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    delayFn(ms).then(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    })
  })
}

export interface WebhookDeliveryQueueOptions {
  store?: PendingDeliveryStore
  maxAttempts?: number
  fetchFn?: typeof fetch
  delayFn?: (ms: number) => Promise<void>
}

export interface DrainResult {
  /** In-flight deliveries that finished (delivered or failed) within the timeout. */
  completed: number
  /** Deliveries persisted for retry after restart. */
  persisted: number
  timedOut: boolean
}

export class WebhookDeliveryQueue {
  private accepting = true
  private readonly abort = new AbortController()
  private readonly active = new Set<{ job: WebhookDeliveryJob; done: Promise<unknown> }>()
  /** Jobs submitted after shutdown began; persisted rather than started. */
  private deferred: WebhookDeliveryJob[] = []
  private readonly store: PendingDeliveryStore
  private readonly maxAttempts: number
  private readonly fetchFn: typeof fetch
  private readonly delayFn: (ms: number) => Promise<void>

  constructor(options: WebhookDeliveryQueueOptions = {}) {
    this.store = options.store ?? createMongoPendingDeliveryStore()
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args))
    this.delayFn = options.delayFn ?? defaultDelay
  }

  get isAccepting(): boolean {
    return this.accepting
  }

  get inFlightCount(): number {
    return this.active.size
  }

  /**
   * Starts delivering `payload` to `endpoint`. Returns the delivery promise,
   * or null when the queue is shutting down — the job is then kept and
   * persisted for retry after restart instead of being started.
   */
  enqueue(
    endpoint: string,
    payload: WebhookPayload,
    attempts = 0,
  ): Promise<WebhookDeliveryRecord> | null {
    const job: WebhookDeliveryJob = { endpoint, payload, attempts }

    if (!this.accepting) {
      console.warn(
        `[webhook] queue closed — deferring key=${payload.idempotency_key} for retry after restart`,
      )
      if (this.abort.signal.aborted) {
        // Drain already finished; persist straight away.
        this.persist([job])
      } else {
        this.deferred.push(job)
      }
      return null
    }

    const entry = { job, done: Promise.resolve() as Promise<unknown> }
    const done = deliverWebhook(
      endpoint,
      payload,
      this.maxAttempts,
      this.fetchFn,
      (ms) => abortableDelay(this.delayFn, ms, this.abort.signal),
      {
        signal: this.abort.signal,
        startAttempt: attempts,
        onAttempt: (n) => {
          job.attempts = n
        },
      },
    ).then((record) => {
      // A "pending" record was interrupted by drain; keep it tracked so it is
      // persisted. Finished deliveries (delivered/failed) are dropped.
      if (record.status !== "pending") this.active.delete(entry)
      return record
    })
    entry.done = done
    this.active.add(entry)
    return done
  }

  /** Stops starting new deliveries; later enqueues are deferred for restart. */
  stopAccepting(): void {
    if (this.accepting) {
      this.accepting = false
      console.log("[webhook] queue stopped accepting new deliveries")
    }
  }

  /**
   * Stops accepting jobs, waits up to `timeoutMs` for in-flight deliveries,
   * then halts retries and persists every unfinished job for retry.
   */
  async drain(timeoutMs: number): Promise<DrainResult> {
    this.stopAccepting()
    const startedWith = this.active.size
    console.log(
      `[webhook] draining ${startedWith} in-flight deliver${startedWith === 1 ? "y" : "ies"} (timeout ${timeoutMs}ms)`,
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      Promise.allSettled([...this.active].map((e) => e.done)).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])
    clearTimeout(timer)

    // Stop further attempts/backoff. Anything still tracked is unfinished.
    this.abort.abort()
    const unfinished = [...[...this.active].map((e) => ({ ...e.job })), ...this.deferred]
    const completed = startedWith - this.active.size
    this.active.clear()
    this.deferred = []

    if (unfinished.length > 0) await this.persist(unfinished)

    console.log(
      `[webhook] drain ${timedOut ? "timed out" : "complete"}: ` +
        `${completed} finished, ${unfinished.length} persisted for retry`,
    )
    return { completed, persisted: unfinished.length, timedOut }
  }

  /** Re-enqueues deliveries persisted by a previous process. */
  async resumePending(): Promise<number> {
    const jobs = await this.store.takeAll()
    for (const job of jobs) this.enqueue(job.endpoint, job.payload, job.attempts)
    if (jobs.length > 0) {
      console.log(`[webhook] resumed ${jobs.length} persisted deliver${jobs.length === 1 ? "y" : "ies"}`)
    }
    return jobs.length
  }

  private async persist(jobs: WebhookDeliveryJob[]): Promise<void> {
    try {
      await this.store.save(jobs)
    } catch (err) {
      console.error(
        `[webhook] failed to persist ${jobs.length} unfinished deliver${jobs.length === 1 ? "y" : "ies"}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

/** Process-wide queue used by the backend entrypoint. */
export const webhookDeliveryQueue = new WebhookDeliveryQueue()
