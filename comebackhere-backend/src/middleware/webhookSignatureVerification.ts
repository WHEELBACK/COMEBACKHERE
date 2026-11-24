/**
 * Incoming webhook signature verification middleware.
 *
 * Verifies SHA-256 HMAC signatures on incoming partner callbacks before
 * parsing the request body. This middleware:
 *
 * 1. Captures the raw request body (before JSON parsing)
 * 2. Extracts and validates the `X-COMEBACKHERE-Signature` header
 * 3. Validates the `X-COMEBACKHERE-Timestamp` header (±5 minute tolerance)
 * 4. Recomputes the HMAC-SHA256 over `timestamp.rawBody`
 * 5. Uses constant-time comparison to prevent timing attacks
 * 6. Rejects requests with invalid or missing signatures
 *
 * The raw body is preserved as `req.rawBody` for signature verification and
 * can be used by downstream handlers that need the exact bytes.
 */

import type { Request, Response, NextFunction } from "express"
import { verifySignature } from "../services/webhooks.js"

declare global {
  namespace Express {
    interface Request {
      /** The raw request body as a Buffer, captured before JSON parsing. */
      rawBody?: Buffer
      /** The verified webhook timestamp from the X-COMEBACKHERE-Timestamp header. */
      webhookTimestamp?: number
    }
  }
}

/** Maximum age of a webhook timestamp (5 minutes in seconds). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

/** Default maximum accepted raw webhook body size (1 MiB). */
export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024

/** Matches a lowercase hex SHA-256 digest (exactly 64 chars). */
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/

/** Matches a non-negative integer Unix timestamp (digits only). */
const TIMESTAMP_PATTERN = /^[0-9]+$/

/**
 * Resolve the configured maximum webhook body size from the environment,
 * falling back to {@link DEFAULT_MAX_WEBHOOK_BODY_BYTES} when unset or invalid.
 */
export function getMaxWebhookBodyBytes(): number {
  const raw = process.env.WEBHOOK_MAX_BODY_BYTES
  if (!raw) {
    return DEFAULT_MAX_WEBHOOK_BODY_BYTES
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_WEBHOOK_BODY_BYTES
  }
  return parsed
}

/**
 * Extract a correlation ID for logging without leaking secrets.
 * Prefers an explicit correlation header, then the delivery ID, then "-".
 */
function getCorrelationId(req: Request): string {
  const correlationId =
    req.get("X-COMEBACKHERE-Correlation-Id") ||
    req.get("X-COMEBACKHERE-Delivery-Id") ||
    req.get("X-Request-Id")
  return correlationId ? correlationId.slice(0, 128) : "-"
}

/** Log a webhook rejection without including secrets or raw payloads. */
function logRejection(req: Request, code: string, detail?: string): void {
  const correlationId = getCorrelationId(req)
  const suffix = detail ? ` (${detail})` : ""
  // eslint-disable-next-line no-console
  console.warn(`[webhook-signature] rejected code=${code} correlationId=${correlationId}${suffix}`)
}
=======

/**
 * Middleware that captures the raw body for incoming webhook requests.
 *
 * This must be applied before express.json() on the webhook route so the
 * raw bytes are available for signature verification.
 *
 * Usage in app.ts:
 * ```ts
 * app.post(
 *   "/webhooks/incoming",
 *   captureRawBody,
 *   verifyWebhookSignature,
 *   express.json({ limit: "100kb" }),
 *   handleIncomingWebhook
 * )
 * ```
 */
export function captureRawBody(req: Request, res: Response, next: NextFunction) {
  const maxBytes = getMaxWebhookBodyBytes()
  const chunks: Buffer[] = []
  let totalBytes = 0
  let aborted = false

  req.on("data", (chunk: Buffer) => {
    if (aborted) {
      return
    }
    totalBytes += chunk.length
    if (totalBytes > maxBytes) {
      aborted = true
      logRejection(req, "PAYLOAD_TOO_LARGE", `bytes>${maxBytes}`)
      res.status(413).json({
        error: "Payload Too Large",
        code: "PAYLOAD_TOO_LARGE",
        message: `Webhook body exceeds maximum size of ${maxBytes} bytes`,
      })
      // Stop buffering further data; drain the stream to avoid hanging.
      req.removeAllListeners("data")
      req.resume()
      return
    }
    chunks.push(chunk)
  })

  req.on("end", () => {
    if (aborted) {
      return
    }
    req.rawBody = Buffer.concat(chunks)
    next()
  })

  req.on("error", (err: Error) => {
    if (aborted) {
      return
    }
    aborted = true
    next(err)
  })
}

/**
 * Verify the HMAC-SHA256 signature on an incoming webhook request.
 *
 * The signature is computed over `timestamp.rawBody` using the partner's
 * signing secret. The header format is:
 *   X-COMEBACKHERE-Signature: <lowercase hex digest>
 *
 * Requires `req.rawBody` to be set by `captureRawBody` middleware.
 *
 * Responds with 401 Unauthorized if:
 *   - `X-COMEBACKHERE-Signature` header is missing
 *   - `X-COMEBACKHERE-Timestamp` header is missing
 *   - Timestamp is outside ±5 minute tolerance
 *   - Signature does not match the computed HMAC-SHA256
 *
 * On success, stores the verified timestamp in `req.webhookTimestamp` and
 * calls `next()` to proceed to the next middleware.
 */
export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction) {
  // 1. Extract signature and timestamp headers
  const signature = req.get("X-COMEBACKHERE-Signature")
  const timestampStr = req.get("X-COMEBACKHERE-Timestamp")

  if (!signature) {
    logRejection(req, "MISSING_SIGNATURE")
    return res.status(401).json({
      error: "Unauthorized",
      code: "MISSING_SIGNATURE",
      message: "Missing X-COMEBACKHERE-Signature header",
    })
  }

  if (!timestampStr) {
    logRejection(req, "MISSING_TIMESTAMP")
    return res.status(401).json({
      error: "Unauthorized",
      code: "MISSING_TIMESTAMP",
      message: "Missing X-COMEBACKHERE-Timestamp header",
    })
  }

  // 2. Validate signature header format before any HMAC work.
  if (!SIGNATURE_HEX_PATTERN.test(signature)) {
    logRejection(req, "INVALID_SIGNATURE", "malformed-signature-header")
    return res.status(401).json({
      error: "Unauthorized",
      code: "INVALID_SIGNATURE",
      message: "Signature verification failed",
    })
  }

  // 3. Validate and parse timestamp (digits only, non-negative).
  if (!TIMESTAMP_PATTERN.test(timestampStr)) {
    logRejection(req, "INVALID_TIMESTAMP", "non-numeric-timestamp")
    return res.status(401).json({
      error: "Unauthorized",
      code: "INVALID_TIMESTAMP",
      message: "X-COMEBACKHERE-Timestamp must be a valid Unix timestamp",
    })
  }

  const timestamp = Number.parseInt(timestampStr, 10)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    logRejection(req, "INVALID_TIMESTAMP", "out-of-range-timestamp")
    return res.status(401).json({
      error: "Unauthorized",
      code: "INVALID_TIMESTAMP",
      message: "X-COMEBACKHERE-Timestamp must be a valid Unix timestamp",
    })
  }

  // 4. Check timestamp is within tolerance (±5 minutes)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const ageSec = nowSeconds - timestamp
  if (Math.abs(ageSec) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    logRejection(req, "TIMESTAMP_OUT_OF_TOLERANCE", `age=${Math.abs(ageSec)}s`)
    return res.status(401).json({
      error: "Unauthorized",
      code: "TIMESTAMP_OUT_OF_TOLERANCE",
      message: `Timestamp is ${Math.abs(ageSec)} seconds old (max ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS}s)`,
    })
  }

  // 5. Verify raw body is present (set by captureRawBody)
  if (!req.rawBody) {
    logRejection(req, "MISSING_RAW_BODY")
    return res.status(500).json({
      error: "Internal Server Error",
      code: "MISSING_RAW_BODY",
      message: "Raw body was not captured; verify middleware order",
    })
  }

  // 6. Enforce maximum body size before HMAC computation.
  const maxBytes = getMaxWebhookBodyBytes()
  if (req.rawBody.length > maxBytes) {
    logRejection(req, "PAYLOAD_TOO_LARGE", `bytes=${req.rawBody.length}`)
    return res.status(413).json({
      error: "Payload Too Large",
      code: "PAYLOAD_TOO_LARGE",
      message: `Webhook body exceeds maximum size of ${maxBytes} bytes`,
    })
  }

  // 7. Get signing secret from environment or request header
  // Prioritize per-request secret (for multi-partner scenarios) over environment variable
  const signingSecret = req.get("X-COMEBACKHERE-Partner-Secret") || process.env.WEBHOOK_INCOMING_SECRET
  if (!signingSecret) {
    logRejection(req, "SIGNING_SECRET_NOT_CONFIGURED")
    return res.status(500).json({
      error: "Internal Server Error",
      code: "SIGNING_SECRET_NOT_CONFIGURED",
      message: "Webhook signing secret is not configured",
    })
  }

  // 8. Verify the signature over `timestamp.rawBody` using constant-time comparison.
  const message = `${timestamp}.`
  const fullMessage = Buffer.concat([Buffer.from(message), req.rawBody])
  if (!verifySignature(signingSecret, fullMessage, signature)) {
    logRejection(req, "INVALID_SIGNATURE", "signature-mismatch")
    return res.status(401).json({
      error: "Unauthorized",
      code: "INVALID_SIGNATURE",
      message: "Signature verification failed",
    })
  }

  // 9. Signature is valid; store timestamp and proceed
  req.webhookTimestamp = timestamp
  next()
}

/**
 * Middleware to deduplicate webhook deliveries by `X-COMEBACKHERE-Delivery-Id`.
 *
 * Stores delivery IDs in memory (or Redis in production) and rejects requests
 * with duplicate delivery IDs to prevent re-processing the same event twice
 * (e.g., when a partner retries a request).
 *
 * If deduplication is not needed, this middleware can be omitted.
 */
export interface DeduplicationStore {
  has(deliveryId: string): boolean
  add(deliveryId: string, expirySeconds?: number): void
}

export class InMemoryDeduplicationStore implements DeduplicationStore {
  private store = new Map<string, NodeJS.Timeout>()

  has(deliveryId: string): boolean {
    return this.store.has(deliveryId)
  }

  add(deliveryId: string, expirySeconds = 3600): void {
    if (this.store.has(deliveryId)) {
      return
    }
    const timeout = setTimeout(() => this.store.delete(deliveryId), expirySeconds * 1000)
    timeout.unref?.()
    this.store.set(deliveryId, timeout)
  }

  clear(): void {
    for (const timeout of this.store.values()) {
      clearTimeout(timeout)
    }
    this.store.clear()
  }
}

/**
 * Create a middleware that deduplicates webhook deliveries.
 *
 * Usage in app.ts:
 * ```ts
 * const dedupStore = new InMemoryDeduplicationStore()
 * app.post(
 *   "/webhooks/incoming",
 *   captureRawBody,
 *   verifyWebhookSignature,
 *   deduplicateWebhookDelivery(dedupStore),
 *   express.json({ limit: "100kb" }),
 *   handleIncomingWebhook
 * )
 * ```
 */
export function deduplicateWebhookDelivery(store: DeduplicationStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const deliveryId = req.get("X-COMEBACKHERE-Delivery-Id")

    if (!deliveryId) {
      return res.status(400).json({
        error: "Bad Request",
        code: "MISSING_DELIVERY_ID",
        message: "Missing X-COMEBACKHERE-Delivery-Id header",
      })
    }

    if (store.has(deliveryId)) {
      // Duplicate detected; acknowledge without reprocessing
      return res.status(200).json({
        status: "duplicate",
        delivery_id: deliveryId,
        message: "Delivery already processed",
      })
    }

    store.add(deliveryId)
    next()
  }
}
