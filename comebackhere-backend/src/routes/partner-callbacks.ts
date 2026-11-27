/**
 * Partner webhook callback handlers.
 *
 * This module handles inbound webhook callbacks from external partners.
 * All requests are verified for HMAC-SHA256 signatures before processing.
 *
 * Example flow:
 * 1. Partner sends POST /webhooks/incoming with signed payload
 * 2. captureRawBody middleware captures the raw bytes
 * 3. verifyWebhookSignature middleware validates the HMAC-SHA256 signature
 * 4. deduplicateWebhookDelivery middleware checks for duplicate deliveries
 * 5. handleIncomingWebhook processes the verified payload
 *
 * Incoming webhooks can include:
 * - Settlement notifications from partners
 * - Status updates on invoice reconciliation
 * - Compliance event notifications
 * - Custom partner-specific events
 */

import express, { type Request, type Response } from "express"

const router = express.Router()

/**
 * POST /webhooks/incoming
 *
 * Receive and process a verified webhook from an external partner.
 *
 * Request headers (verified before this handler runs):
 *   - X-COMEBACKHERE-Signature: HMAC-SHA256 hex digest over `timestamp.rawBody`
 *   - X-COMEBACKHERE-Timestamp: Unix timestamp (seconds) when the request was created
 *   - X-COMEBACKHERE-Delivery-Id: Unique delivery ID for deduplication
 *   - X-COMEBACKHERE-Event-Id: Optional event identifier
 *   - X-Request-Id: Optional correlation ID
 *   - Content-Type: application/json
 *
 * Request body schema (after signature verification):
 *   {
 *     "event": string,          // Event type (e.g., "settlement.completed")
 *     "partner": string,        // Partner identifier
 *     "data": object,           // Event-specific payload
 *     "occurred_at": number,    // Unix timestamp when the event occurred
 *   }
 *
 * Response:
 *   HTTP 200 OK
 *   {
 *     "status": "processed",
 *     "delivery_id": "<delivery-id>",
 *     "event": "<event-type>",
 *     "processed_at": "<ISO8601-timestamp>"
 *   }
 *
 * Error responses (before signature verification):
 *   - 401 Unauthorized: Missing or invalid signature
 *   - 400 Bad Request: Missing required headers or malformed payload
 *   - 429 Too Many Requests: Rate limited
 *
 * Error responses (after processing):
 *   - 422 Unprocessable Entity: Event processing failed (idempotently retryable)
 *   - 500 Internal Server Error: Unexpected error during processing
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const deliveryId = req.get("X-COMEBACKHERE-Delivery-Id") || "unknown"
    const eventId = req.get("X-COMEBACKHERE-Event-Id")
    const correlationId = req.get("X-Request-Id")
    const timestamp = req.webhookTimestamp || Math.floor(Date.now() / 1000)

    // Extract and validate payload
    const payload = req.body as Record<string, unknown>
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        error: "Bad Request",
        code: "INVALID_PAYLOAD",
        message: "Request body must be a JSON object",
      })
    }

    const event = payload.event as string | undefined
    if (!event || typeof event !== "string") {
      return res.status(400).json({
        error: "Bad Request",
        code: "MISSING_EVENT",
        message: "Missing or invalid 'event' field",
      })
    }

    const partner = payload.partner as string | undefined
    if (!partner || typeof partner !== "string") {
      return res.status(400).json({
        error: "Bad Request",
        code: "MISSING_PARTNER",
        message: "Missing or invalid 'partner' field",
      })
    }

    const data = payload.data as Record<string, unknown> | undefined
    if (!data || typeof data !== "object") {
      return res.status(400).json({
        error: "Bad Request",
        code: "MISSING_DATA",
        message: "Missing or invalid 'data' field",
      })
    }

    const occurredAt = payload.occurred_at as number | undefined
    if (typeof occurredAt !== "number" || occurredAt <= 0) {
      return res.status(400).json({
        error: "Bad Request",
        code: "INVALID_OCCURRED_AT",
        message: "Missing or invalid 'occurred_at' Unix timestamp",
      })
    }

    // Log incoming webhook (sensitive data redacted)
    console.log("[webhook-incoming]", {
      delivery_id: deliveryId,
      event_id: eventId,
      correlation_id: correlationId,
      partner,
      event,
      occurred_at: new Date(occurredAt * 1000).toISOString(),
      timestamp,
    })

    // Dispatch to event-specific handler
    // In a real implementation, this would:
    // 1. Route to handler based on `event` type
    // 2. Validate event-specific data schema
    // 3. Persist webhook record in MongoDB
    // 4. Emit events to downstream systems (e.g., indexer, compliance engine)
    // 5. Return error if processing fails idempotently
    //
    // For now, we acknowledge receipt.
    // Future: handlePartnerWebhookEvent(event, data, partner, timestamp)

    res.status(200).json({
      status: "processed",
      delivery_id: deliveryId,
      event,
      processed_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[webhook-incoming] error:", err instanceof Error ? err.message : err)
    res.status(500).json({
      error: "Internal Server Error",
      code: "PROCESSING_FAILED",
      message: "Failed to process incoming webhook",
      delivery_id: req.get("X-COMEBACKHERE-Delivery-Id"),
    })
  }
})

export default router
