/**
 * Outbound webhook delivery with HMAC-SHA256 request signing.
 *
 * Every webhook POST includes a timestamp and an HMAC-SHA256 signature over
 * `timestamp.rawBody`, plus a body-only legacy digest during the migration
 * release. Both digests use `WEBHOOK_SIGNING_SECRET` or the explicit secret.
 *
 * Consumers verify authenticity by:
 *   1. Reading the raw request body as bytes (before JSON.parse).
 *   2. Rejecting timestamps outside the five-minute tolerance.
 *   3. Computing HMAC-SHA256(secret, timestamp + "." + rawBody).
 *   4. Comparing the hex digest to the `X-COMEBACKHERE-Signature` header
 *      using a constant-time comparison to prevent timing attacks.
 *
 * The signature is computed over the raw body bytes (Buffer/Uint8Array), not a
 * decoded string. This keeps verification stable when the body contains
 * non-UTF-8 characters or when a proxy preserves the raw payload without
 * re-encoding it.
 *
 * Header name: `X-COMEBACKHERE-Signature`
 * Algorithm:   HMAC-SHA256
 * Encoding:    lowercase hex
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto"
import { connectMongo, type WebhookDeliveryHistoryRecord, type WebhookReplayRecord } from "../db/mongo.js"
import {
  webhookDeliveryAttempts,
  webhookDeliveryDuration,
  webhookDeliveryOutcomes,
} from "../lib/metrics.js"
import { sendWebhookRequest } from "./webhook-http.js"

/** The header name sent on every outbound webhook request. */
export const WEBHOOK_SIGNATURE_HEADER = "X-COMEBACKHERE-Signature"
export const WEBHOOK_TIMESTAMP_HEADER = "X-COMEBACKHERE-Timestamp"
export const WEBHOOK_LEGACY_SIGNATURE_HEADER = "X-COMEBACKHERE-Legacy-Signature"
export const WEBHOOK_PREVIOUS_SIGNATURE_HEADER = "X-COMEBACKHERE-Previous-Signature"

export interface WebhookPayload {
  event: string
  event_id?: string
  delivery_id?: string
  [key: string]: unknown
}

export interface WebhookDeliveryResult {
  url: string
  status: number
  ok: boolean
  signature: string
  legacySignature: string
  timestamp: string
  deliveryId: string
}

export interface DispatchWebhookOptions {
  merchantAddress?: string
  correlationId?: string
  replayOf?: string
  eventId?: string
  deliveryId?: string
}

/**
 * Normalize the raw body into the exact bytes that should be signed.
 *
 * HMAC input must be the exact raw bytes of the request body. Passing a
 * `Buffer` or `Uint8Array` preserves the original bytes verbatim, which keeps
 * signatures stable even when the body contains non-UTF-8 characters or when a
 * proxy preserves the raw payload without re-encoding it. Supplying a string
 * still works for backward compatibility and is encoded to its UTF-8 bytes.
 */
function toRawBytes(rawBody: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(rawBody)) return rawBody
  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
  }
  return Buffer.from(rawBody)
}

/**
 * Compute an HMAC-SHA256 signature over `rawBody` using `secret`.
 *
 * @param secret  - The per-merchant signing secret (minimum 32 chars recommended).
 * @param rawBody - The exact bytes (or string) that will be sent as the request body.
 * @returns Lowercase hex-encoded HMAC-SHA256 digest.
 */
export function signPayload(secret: string, rawBody: string | Buffer | Uint8Array): string {
  return createHmac("sha256", secret).update(toRawBytes(rawBody)).digest("hex")
}

/**
 * Verify that `signature` is the valid HMAC-SHA256 of `rawBody` under `secret`.
 * Uses constant-time comparison to mitigate timing side-channels.
 *
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifySignature(
  secret: string | string[],
  rawBody: string | Buffer | Uint8Array,
  signature: string,
): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false
    const actualBuf = Buffer.from(signature, "hex")
    const candidates = Array.isArray(secret) ? secret : [secret]
    let valid = false
    for (const candidate of candidates) {
      const expectedBuf = Buffer.from(signPayload(candidate, rawBody), "hex")
      const matches = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)
      valid = matches || valid
    }
    return valid
  } catch {
    return false
  }
}

/**
 * Dispatch a signed webhook POST to `url`.
 *
 * The raw JSON body is signed before delivery. The signature is sent in the
 * `X-COMEBACKHERE-Signature` header.
 *
 * @param url           - The merchant-configured endpoint to deliver to.
 * @param payload       - The event payload to deliver.
 * @param signingSecret - HMAC signing secret. Falls back to
 *                        `process.env.WEBHOOK_SIGNING_SECRET`.
 * @param fetchImpl     - Optional fetch override for testing (default: global fetch).
 */
export async function dispatchWebhook(
  url: string,
  payload: WebhookPayload,
  signingSecret?: string,
  fetchImpl: typeof fetch = fetch,
  options: DispatchWebhookOptions = {},
): Promise<WebhookDeliveryResult> {
  const secret = signingSecret ?? process.env.WEBHOOK_SIGNING_SECRET
  if (!secret) {
    throw new Error(
      "Webhook signing secret is not configured. " +
        "Set WEBHOOK_SIGNING_SECRET or pass signingSecret explicitly.",
    )
  }

  const eventId = options.eventId ?? payload.event_id ?? randomUUID()
  const deliveryId = options.deliveryId ?? (options.replayOf ? randomUUID() : payload.delivery_id ?? eventId)
  const deliveredPayload: WebhookPayload = { ...payload, event_id: eventId, delivery_id: deliveryId }
  const rawBody = JSON.stringify(deliveredPayload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = signPayload(secret, `${timestamp}.${rawBody}`)
  const legacySignature = signPayload(secret, rawBody)
  const previousSecret = process.env.WEBHOOK_SIGNING_SECRET_PREVIOUS
  const previousSignature = previousSecret && previousSecret !== secret
    ? signPayload(previousSecret, `${timestamp}.${rawBody}`)
    : undefined
  if (options.replayOf) webhookDeliveryRetries.inc()
  let status: number | null = null
  let failure: string | null = null
  const startedAt = Date.now()

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_LEGACY_SIGNATURE_HEADER]: legacySignature,
      "X-COMEBACKHERE-Event-Id": eventId,
      "X-COMEBACKHERE-Delivery-Id": deliveryId,
    }
    if (previousSignature) headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER] = previousSignature
    if (options.correlationId) headers["X-Request-Id"] = options.correlationId
    webhookDeliveryAttempts.inc()
    status = await sendWebhookRequest(url, headers, rawBody, fetchImpl)
    if (status < 200 || status >= 300) failure = `HTTP ${status}`
    return {
      url,
      status,
      ok: failure === null,
      signature,
      legacySignature,
      timestamp,
      deliveryId,
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    const delivered = status !== null && status >= 200 && status < 300
    webhookDeliveryOutcomes.inc({ status: delivered ? "delivered" : "failed" })
    webhookDeliveryDuration.observe({ status: delivered ? "delivered" : "failed" }, (Date.now() - startedAt) / 1_000)
    await persistWebhookAttempt({
      deliveryId,
      merchantAddress: options.merchantAddress,
      endpoint: url,
      payload,
      status,
      failure,
      requestId: options.correlationId ?? null,
      replayOf: options.replayOf,
    })
  }
}

async function persistWebhookAttempt(attempt: {
  deliveryId: string
  merchantAddress?: string
  endpoint: string
  payload: WebhookPayload
  status: number | null
  failure: string | null
  requestId: string | null
  replayOf?: string
}): Promise<void> {
  if (!attempt.merchantAddress) return
  try {
    const collection = (await connectMongo()).collection<WebhookDeliveryHistoryRecord>("webhook_deliveries")
    const attemptedAt = new Date()
    const replay: WebhookReplayRecord = {
      replay_id: attempt.deliveryId,
      request_id: attempt.requestId,
      attempted_at: attemptedAt,
      status: attempt.status !== null && attempt.status >= 200 && attempt.status < 300 ? "delivered" : "failed",
      status_code: attempt.status,
      error: attempt.failure,
    }

    if (attempt.replayOf) {
      await collection.updateOne(
        { delivery_id: attempt.replayOf, merchant_address: attempt.merchantAddress },
        { $push: { replays: replay } },
      )
      return
    }

    await collection.insertOne({
      delivery_id: attempt.deliveryId,
      merchant_address: attempt.merchantAddress,
      endpoint: attempt.endpoint,
      payload: deliveredPayload,
      status: replay.status,
      attempts: 1,
      last_status_code: attempt.status,
      last_error: attempt.failure,
      created_at: attemptedAt,
      replays: [],
    })
  } catch (err) {
    console.error("[webhook] failed to persist delivery history:", err instanceof Error ? err.message : err)
  }
}
