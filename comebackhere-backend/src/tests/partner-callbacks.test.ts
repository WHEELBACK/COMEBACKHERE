/**
 * Partner webhook callback tests.
 *
 * Verify signature validation, timestamp checking, deduplication, and
 * incoming webhook processing.
 */

import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { signPayload, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "../services/webhooks.js"

describe("Partner Callback Webhooks", () => {
  let app: ReturnType<typeof createApp>
  const signingSecret = "test-signing-secret-32-chars-min"
  const testPayload = {
    event: "settlement.completed",
    partner: "partner-123",
    data: {
      settlement_id: "settle_1",
      amount: "1000",
    },
    occurred_at: Math.floor(Date.now() / 1000),
  }

  beforeAll(() => {
    process.env.WEBHOOK_INCOMING_SECRET = signingSecret
    app = createApp()
  })

  describe("Signature verification", () => {
    it("rejects requests without X-COMEBACKHERE-Signature header", async () => {
      const now = Math.floor(Date.now() / 1000)
      const res = await request(app)
        .post("/webhooks/incoming")
        .set("X-COMEBACKHERE-Timestamp", String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("MISSING_SIGNATURE")
    })

    it("rejects requests without X-COMEBACKHERE-Timestamp header", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("MISSING_TIMESTAMP")
    })

    it("rejects requests with non-numeric timestamp", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, "invalid")
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("INVALID_TIMESTAMP")
    })

    it("rejects requests with timestamp outside 5-minute window (too old)", async () => {
      // Timestamp 10 minutes in the past
      const pastTimestamp = Math.floor(Date.now() / 1000) - 600
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${pastTimestamp}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(pastTimestamp))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("TIMESTAMP_OUT_OF_TOLERANCE")
    })

    it("rejects requests with timestamp outside 5-minute window (too new)", async () => {
      // Timestamp 10 minutes in the future
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${futureTimestamp}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(futureTimestamp))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("TIMESTAMP_OUT_OF_TOLERANCE")
    })

    it("rejects requests with invalid signature", async () => {
      const now = Math.floor(Date.now() / 1000)
      const invalidSignature = "0".repeat(64) // Invalid signature

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, invalidSignature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("INVALID_SIGNATURE")
    })

    it("accepts requests with valid signature and timestamp", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(200)
      expect(res.body.status).toBe("processed")
    })

    it("verifies signature over timestamp.rawBody, not just rawBody", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      // Sign incorrectly (without timestamp prefix)
      const invalidSignature = signPayload(signingSecret, rawBody)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, invalidSignature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(testPayload)

      expect(res.status).toBe(401)
      expect(res.body.code).toBe("INVALID_SIGNATURE")
    })
  })

  describe("Deduplication", () => {
    it("accepts first delivery", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "unique-delivery-1")
        .send(testPayload)

      expect(res.status).toBe(200)
      expect(res.body.status).toBe("processed")
    })

    it("rejects duplicate delivery with same delivery ID", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)
      const deliveryId = "duplicate-delivery-test"

      // First delivery
      await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", deliveryId)
        .send(testPayload)

      // Second delivery with same ID (should be deduplicated)
      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", deliveryId)
        .send(testPayload)

      expect(res.status).toBe(200)
      expect(res.body.status).toBe("duplicate")
    })

    it("rejects request without X-COMEBACKHERE-Delivery-Id header", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .send(testPayload)

      expect(res.status).toBe(400)
      expect(res.body.code).toBe("MISSING_DELIVERY_ID")
    })
  })

  describe("Payload validation", () => {
    it("rejects requests with missing 'event' field", async () => {
      const now = Math.floor(Date.now() / 1000)
      const payload = { ...testPayload }
      delete (payload as any).event
      const rawBody = JSON.stringify(payload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(payload)

      expect(res.status).toBe(400)
      expect(res.body.code).toBe("MISSING_EVENT")
    })

    it("rejects requests with missing 'partner' field", async () => {
      const now = Math.floor(Date.now() / 1000)
      const payload = { ...testPayload }
      delete (payload as any).partner
      const rawBody = JSON.stringify(payload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(payload)

      expect(res.status).toBe(400)
      expect(res.body.code).toBe("MISSING_PARTNER")
    })

    it("rejects requests with missing 'data' field", async () => {
      const now = Math.floor(Date.now() / 1000)
      const payload = { ...testPayload }
      delete (payload as any).data
      const rawBody = JSON.stringify(payload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(payload)

      expect(res.status).toBe(400)
      expect(res.body.code).toBe("MISSING_DATA")
    })

    it("rejects requests with missing 'occurred_at' field", async () => {
      const now = Math.floor(Date.now() / 1000)
      const payload = { ...testPayload }
      delete (payload as any).occurred_at
      const rawBody = JSON.stringify(payload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-1")
        .send(payload)

      expect(res.status).toBe(400)
      expect(res.body.code).toBe("INVALID_OCCURRED_AT")
    })
  })

  describe("Success response", () => {
    it("returns 200 with processed status for valid request", async () => {
      const now = Math.floor(Date.now() / 1000)
      const rawBody = JSON.stringify(testPayload)
      const signature = signPayload(signingSecret, `${now}.${rawBody}`)

      const res = await request(app)
        .post("/webhooks/incoming")
        .set(WEBHOOK_SIGNATURE_HEADER, signature)
        .set(WEBHOOK_TIMESTAMP_HEADER, String(now))
        .set("X-COMEBACKHERE-Delivery-Id", "delivery-success-1")
        .set("X-COMEBACKHERE-Event-Id", "event-123")
        .send(testPayload)

      expect(res.status).toBe(200)
      expect(res.body.status).toBe("processed")
      expect(res.body.delivery_id).toBe("delivery-success-1")
      expect(res.body.event).toBe("settlement.completed")
      expect(res.body.processed_at).toBeDefined()
    })
  })
})
