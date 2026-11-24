import { Router, type Request, type Response } from "express"
import { connectMongo, type WebhookDeliveryHistoryRecord } from "../db/mongo.js"
import { asyncHandler, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js"
import { requireMerchantApiKey } from "../middleware/apiKey.js"
import { validateParams } from "../middleware/validate.js"
import { webhookDeliveryIdSchema } from "../schemas/index.js"
import { dispatchWebhook, type WebhookPayload } from "../services/webhooks.js"

const router = Router()

/** Maximum serialized size (in bytes) of a stored webhook payload that may be replayed. */
const MAX_REPLAY_PAYLOAD_BYTES = 64 * 1024

/** Maximum number of top-level keys allowed in a replayed payload. */
const MAX_REPLAY_PAYLOAD_KEYS = 100

/**
 * Returns true when the given value is a plain object (not an array, null, or class instance).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Validates a stored webhook payload before replay.
 *
 * Rejects non-object payloads, oversized payloads, payloads with too many keys,
 * and payloads containing prototype-polluting keys. Throws a ValidationError on
 * any client-caused failure so callers receive a typed 4xx response.
 */
function validateStoredPayload(payload: unknown): WebhookPayload {
  if (!isPlainObject(payload)) {
    throw new ValidationError("Stored webhook payload is not a valid object")
  }
  const keys = Object.keys(payload)
  if (keys.length > MAX_REPLAY_PAYLOAD_KEYS) {
    throw new ValidationError("Stored webhook payload contains too many fields")
  }
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new ValidationError("Stored webhook payload contains forbidden fields")
    }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    throw new ValidationError("Stored webhook payload is not serializable")
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPLAY_PAYLOAD_BYTES) {
    throw new ValidationError("Stored webhook payload exceeds the maximum allowed size")
  }
  return payload as WebhookPayload
}

/**
 * Validates that a stored endpoint is still a public HTTPS URL.
 *
 * Rejects non-HTTPS schemes, embedded credentials, loopback/private/link-local
 * hosts, and malformed URLs. Throws a ForbiddenError so the caller receives a
 * typed 403 rather than a 502.
 */
function validateStoredEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new ForbiddenError("Stored webhook endpoint is invalid")
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new ForbiddenError("Stored webhook endpoint is not a valid URL")
  }
  if (url.protocol !== "https:") {
    throw new ForbiddenError("Stored webhook endpoint must use HTTPS")
  }
  if (url.username || url.password) {
    throw new ForbiddenError("Stored webhook endpoint must not contain credentials")
  }
  const host = url.hostname.toLowerCase()
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new ForbiddenError("Stored webhook endpoint must be a public address")
  }
  return url.toString()
}

/**
 * @openapi
 * /webhooks/{deliveryId}/replay:
 *   post:
 *     tags: [Webhooks]
 *     summary: Replay a failed webhook delivery
 *     parameters:
 *       - in: path
 *         name: deliveryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema: { type: string, example: Bearer merchant-api-key }
 *     responses:
 *       200:
 *         description: Replay delivered
 *       401:
 *         description: Merchant API key is missing, invalid, or revoked
 *       404:
 *         description: Delivery does not belong to this merchant
 *       409:
 *         description: Only failed deliveries can be replayed
 *       502:
 *         description: Merchant endpoint returned a non-success response
 */
router.post("/:deliveryId/replay", requireMerchantApiKey, validateParams(webhookDeliveryIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const merchantAddress = res.locals.merchantAddress as string
  const collection = (await connectMongo()).collection<WebhookDeliveryHistoryRecord>("webhook_deliveries")
  const delivery = await collection.findOne({
    delivery_id: req.params.deliveryId,
    merchant_address: merchantAddress,
  })
  if (!delivery) throw new NotFoundError("Webhook delivery not found")
  if (delivery.status !== "failed") throw new ConflictError("Only failed webhook deliveries can be replayed")

  const endpoint = validateStoredEndpoint(delivery.endpoint)
  const payload = validateStoredPayload(delivery.payload)

  const result = await dispatchWebhook(
    endpoint,
    payload,
    undefined,
    fetch,
    {
      merchantAddress,
      correlationId: typeof res.locals.requestId === "string" ? res.locals.requestId : undefined,
      replayOf: delivery.delivery_id,
    },
  )
  res.status(result.ok ? 200 : 502).json({
    delivery_id: delivery.delivery_id,
    replay_id: result.deliveryId,
    status: result.ok ? "delivered" : "failed",
    status_code: result.status,
  })
}))

export default router
