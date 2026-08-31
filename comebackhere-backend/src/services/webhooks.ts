/**
 * Outbound webhook delivery with HMAC-SHA256 request signing.
 *
 * Every webhook POST includes a `X-COMEBACKHERE-Signature` header containing
 * an HMAC-SHA256 hex digest of the raw JSON request body, keyed by the
 * per-merchant signing secret (`WEBHOOK_SIGNING_SECRET` env var, or the
 * `signingSecret` argument when called directly).
 *
 * Consumers verify authenticity by:
 *   1. Reading the raw request body as bytes (before JSON.parse).
 *   2. Computing HMAC-SHA256(secret, rawBody) over those exact bytes.
 *   3. Comparing the hex digest to the `X-COMEBACKHERE-Signature` header
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

import { createHmac, timingSafeEqual } from "crypto"

/** The header name sent on every outbound webhook request. */
export const WEBHOOK_SIGNATURE_HEADER = "X-COMEBACKHERE-Signature"

export interface WebhookPayload {
  event: string
  [key: string]: unknown
}

export interface WebhookDeliveryResult {
  url: string
  status: number
  ok: boolean
  signature: string
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
  secret: string,
  rawBody: string | Buffer | Uint8Array,
  signature: string,
): boolean {
  try {
    const expected = signPayload(secret, rawBody)
    // Both buffers must have the same length for timingSafeEqual
    const expectedBuf = Buffer.from(expected, "hex")
    const actualBuf = Buffer.from(signature, "hex")
    if (expectedBuf.length !== actualBuf.length) return false
    return timingSafeEqual(expectedBuf, actualBuf)
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
): Promise<WebhookDeliveryResult> {
  const secret = signingSecret ?? process.env.WEBHOOK_SIGNING_SECRET
  if (!secret) {
    throw new Error(
      "Webhook signing secret is not configured. " +
        "Set WEBHOOK_SIGNING_SECRET or pass signingSecret explicitly.",
    )
  }

  const rawBody = JSON.stringify(payload)
  const signature = signPayload(secret, rawBody)

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    },
    body: rawBody,
  })

  return {
    url,
    status: response.status,
    ok: response.ok,
    signature,
  }
}
