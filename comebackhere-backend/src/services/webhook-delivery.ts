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
  const record: WebhookDeliveryRecord = {
    idempotency_key: payload.idempotency_key,
    endpoint,
    payload,
    status: "pending",
    attempts: 0,
    last_attempt_at: null,
    last_status_code: null,
    last_error: null,
    request_id: correlationId ?? null,
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
