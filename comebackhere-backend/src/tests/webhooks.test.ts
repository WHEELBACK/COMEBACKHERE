/**
 * Tests for outbound webhook HMAC-SHA256 signing (#208).
 *
 * Covers:
 * - signPayload produces correct HMAC-SHA256
 * - verifySignature accepts a valid signature
 * - verifySignature rejects a tampered payload
 * - verifySignature rejects a wrong secret
 * - verifySignature is constant-time safe (length mismatch returns false)
 * - dispatchWebhook sends X-COMEBACKHERE-Signature header
 * - dispatchWebhook signature matches what verifySignature accepts
 * - dispatchWebhook throws when no signing secret is configured
 * - dispatchWebhook result includes ok/status from the upstream response
 * - dispatchWebhook sends exactly the headers docs/webhooks.md documents
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHmac } from "crypto"
import {
  signPayload,
  verifySignature,
  dispatchWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_PREVIOUS_SIGNATURE_HEADER,
  type WebhookPayload,
} from "../services/webhooks.js"
import { createPinnedLookup, resolvePublicAddress, sendWebhookRequest } from "../services/webhook-http.js"
import { lookup as dnsLookup } from "node:dns/promises"

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]),
}))

const TEST_SECRET = "super-secret-hmac-key-at-least-32-chars!"
const TEST_URL = "https://merchant.example.com/webhooks"

// ---------------------------------------------------------------------------
// signPayload
// ---------------------------------------------------------------------------

describe("signPayload", () => {
  it("returns a lowercase hex HMAC-SHA256 digest", () => {
    const body = JSON.stringify({ event: "settlement_executed", settlement_id: 1 })
    const sig = signPayload(TEST_SECRET, body)

    // Must be 64-char lowercase hex
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it("matches a manually computed HMAC-SHA256", () => {
    const body = '{"event":"settlement_proposed","settlement_id":42}'
    const expected = createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("hex")
    expect(signPayload(TEST_SECRET, body)).toBe(expected)
  })

  it("produces different signatures for different secrets", () => {
    const body = '{"event":"test"}'
    const sig1 = signPayload("secret-one-aaaaaaaaaaaaaaaaaaaaa", body)
    const sig2 = signPayload("secret-two-bbbbbbbbbbbbbbbbbbbbb", body)
    expect(sig1).not.toBe(sig2)
  })

  it("produces different signatures for different bodies", () => {
    const sig1 = signPayload(TEST_SECRET, '{"event":"a"}')
    const sig2 = signPayload(TEST_SECRET, '{"event":"b"}')
    expect(sig1).not.toBe(sig2)
  })
})

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const body = '{"event":"settlement_executed","settlement_id":7}'
    const sig = signPayload(TEST_SECRET, body)
    expect(verifySignature(TEST_SECRET, body, sig)).toBe(true)
  })

  it("returns false when the payload has been tampered with", () => {
    const body = '{"event":"settlement_executed","settlement_id":7}'
    const sig = signPayload(TEST_SECRET, body)
    const tampered = '{"event":"settlement_executed","settlement_id":9999}'
    expect(verifySignature(TEST_SECRET, tampered, sig)).toBe(false)
  })

  it("returns false when the wrong secret is used", () => {
    const body = '{"event":"settlement_proposed","settlement_id":1}'
    const sig = signPayload(TEST_SECRET, body)
    expect(verifySignature("wrong-secret-aaaaaaaaaaaaaaaaaaaaaa", body, sig)).toBe(false)
  })

  it("returns false when the signature is an empty string", () => {
    const body = '{"event":"test"}'
    expect(verifySignature(TEST_SECRET, body, "")).toBe(false)
  })

  it("returns false when the signature is malformed (non-hex)", () => {
    const body = '{"event":"test"}'
    expect(verifySignature(TEST_SECRET, body, "not-a-valid-hex-signature!!")).toBe(false)
  })

  it("accepts signatures made with either key during a rotation overlap", () => {
    const body = "timestamp.{\"event\":\"test\"}"
    const oldSignature = signPayload("old-secret", body)
    const newSignature = signPayload("new-secret", body)

    expect(verifySignature(["old-secret", "new-secret"], body, oldSignature)).toBe(true)
    expect(verifySignature(["old-secret", "new-secret"], body, newSignature)).toBe(true)
  })

  it("returns false when signature length does not match (timing-safe guard)", () => {
    const body = '{"event":"test"}'
    // Truncated hex — different byte length
    expect(verifySignature(TEST_SECRET, body, "abcd")).toBe(false)
  })

  it("signs raw non-UTF-8 bytes without data loss", () => {
    // Body containing raw bytes that are not valid UTF-8 (e.g. latin-1 payload
    // passed through by a proxy). Signing the raw bytes must match a signature
    // produced from the identical byte buffer.
    const rawBody = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d])
    const sig = signPayload(TEST_SECRET, rawBody)
    expect(verifySignature(TEST_SECRET, rawBody, sig)).toBe(true)
  })

  it("accepts a Uint8Array body for signing and verification", () => {
    const bodyBytes = Buffer.from('{"event":"test"}')
    const asUint8 = new Uint8Array(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
    const sig = signPayload(TEST_SECRET, asUint8)
    expect(verifySignature(TEST_SECRET, asUint8, sig)).toBe(true)
  })

  it("buffer signature matches the string signature for the same UTF-8 payload", () => {
    const body = '{"event":"test"}'
    const bodyBuf = Buffer.from(body)
    expect(signPayload(TEST_SECRET, bodyBuf)).toBe(signPayload(TEST_SECRET, body))
  })

  it("tampered raw bytes fail verification", () => {
    const original = Buffer.from('{"event":"test"}')
    const tampered = Buffer.from('{"event":"other"}')
    const sig = signPayload(TEST_SECRET, original)
    expect(verifySignature(TEST_SECRET, tampered, sig)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// dispatchWebhook
// ---------------------------------------------------------------------------

describe("dispatchWebhook", () => {
  let envBackup: string | undefined
  let previousEnvBackup: string | undefined

  beforeEach(() => {
    envBackup = process.env.WEBHOOK_SIGNING_SECRET
    previousEnvBackup = process.env.WEBHOOK_SIGNING_SECRET_PREVIOUS
  })

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.WEBHOOK_SIGNING_SECRET
    } else {
      process.env.WEBHOOK_SIGNING_SECRET = envBackup
    }
    if (previousEnvBackup === undefined) {
      delete process.env.WEBHOOK_SIGNING_SECRET_PREVIOUS
    } else {
      process.env.WEBHOOK_SIGNING_SECRET_PREVIOUS = previousEnvBackup
    }
  })

  it("sends X-COMEBACKHERE-Signature header on the outbound request", async () => {
    const capturedHeaders: Record<string, string> = {}

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        capturedHeaders[k] = v as string
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "settlement_executed", settlement_id: 1 },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBeDefined()
    expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/)
  })

  it("signature in the header verifies correctly against the body sent", async () => {
    let capturedBody = ""
    let capturedSignature = ""
    let capturedTimestamp = ""

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string
      const headers = init?.headers as Record<string, string>
      capturedSignature = headers[WEBHOOK_SIGNATURE_HEADER]
      capturedTimestamp = headers[WEBHOOK_TIMESTAMP_HEADER]
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "settlement_proposed", settlement_id: 42, merchant_address: "G..." },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    // The consumer should be able to verify the signature
    expect(verifySignature(TEST_SECRET, `${capturedTimestamp}.${capturedBody}`, capturedSignature)).toBe(true)
  })

  it("a tampered body fails signature verification", async () => {
    let capturedSignature = ""
    let capturedTimestamp = ""

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      capturedSignature = headers[WEBHOOK_SIGNATURE_HEADER]
      capturedTimestamp = headers[WEBHOOK_TIMESTAMP_HEADER]
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "settlement_approved", settlement_id: 5 },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    const tampered = JSON.stringify({ event: "settlement_approved", settlement_id: 9999 })
    expect(verifySignature(TEST_SECRET, `${capturedTimestamp}.${tampered}`, capturedSignature)).toBe(false)
  })

  it("returns ok:true and status from the upstream response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    const result = await dispatchWebhook(
      TEST_URL,
      { event: "settlement_executed", settlement_id: 1 },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.url).toBe(TEST_URL)
  })

  it("returns ok:false when upstream responds with 4xx", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }))

    const result = await dispatchWebhook(
      TEST_URL,
      { event: "test_event" },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })

  it("throws when no signing secret is configured", async () => {
    delete process.env.WEBHOOK_SIGNING_SECRET

    await expect(
      dispatchWebhook(TEST_URL, { event: "test_event" }),
    ).rejects.toThrow(/signing secret is not configured/)
  })

  it("falls back to WEBHOOK_SIGNING_SECRET env var when no secret is passed", async () => {
    process.env.WEBHOOK_SIGNING_SECRET = TEST_SECRET

    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    const result = await dispatchWebhook(
      TEST_URL,
      { event: "settlement_proposed", settlement_id: 1 },
      undefined,
      mockFetch as unknown as typeof fetch,
    )

    expect(result.ok).toBe(true)
    // Signature should be present and valid
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sends Content-Type: application/json", async () => {
    let capturedContentType = ""

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedContentType = (init?.headers as Record<string, string>)["Content-Type"]
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "test_event" },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    expect(capturedContentType).toBe("application/json")
  })

  it("sends stable event and delivery identifiers in the payload and headers", async () => {
    let capturedBody = ""
    const capturedHeaders: Record<string, string> = {}
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string
      for (const [key, value] of Object.entries(init?.headers ?? {})) capturedHeaders[key] = value as string
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    const result = await dispatchWebhook(
      TEST_URL,
      { event: "settlement_executed", settlement_id: 1 },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
      { eventId: "chain-event-123" },
    )

    const sent = JSON.parse(capturedBody) as Record<string, unknown>
    expect(sent.event_id).toBe("chain-event-123")
    expect(sent.delivery_id).toBe(result.deliveryId)
    expect(capturedHeaders["X-COMEBACKHERE-Event-Id"]).toBe("chain-event-123")
    expect(capturedHeaders["X-COMEBACKHERE-Delivery-Id"]).toBe(result.deliveryId)
  })

  it("sends a previous-key signature during the configured rotation overlap", async () => {
    process.env.WEBHOOK_SIGNING_SECRET_PREVIOUS = "old-secret"
    let capturedBody = ""
    const capturedHeaders: Record<string, string> = {}
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string
      for (const [key, value] of Object.entries(init?.headers ?? {})) capturedHeaders[key] = value as string
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(TEST_URL, { event: "test" }, TEST_SECRET, mockFetch as unknown as typeof fetch)

    const timestamp = capturedHeaders[WEBHOOK_TIMESTAMP_HEADER]
    expect(verifySignature(
      "old-secret",
      `${timestamp}.${capturedBody}`,
      capturedHeaders[WEBHOOK_PREVIOUS_SIGNATURE_HEADER],
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Header contract
//
// These pin the exact claims docs/webhooks.md makes about the live dispatch
// path. If dispatchWebhook starts (or stops) sending a header, this fails and
// the docs must be updated to match.
// ---------------------------------------------------------------------------

describe("dispatchWebhook — header contract", () => {
  const capture = async (payload: WebhookPayload): Promise<Record<string, string>> => {
    const captured: Record<string, string> = {}
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        captured[k.toLowerCase()] = v
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(TEST_URL, payload, TEST_SECRET, mockFetch as unknown as typeof fetch)
    return captured
  }

  it("sends the documented signature, timestamp, and identifier headers", async () => {
    const headers = await capture({ event: "settlement_executed", settlement_id: 1 })
    expect(Object.keys(headers).sort()).toEqual([
      "content-type",
      "x-comebackhere-delivery-id",
      "x-comebackhere-event-id",
      "x-comebackhere-legacy-signature",
      "x-comebackhere-signature",
      "x-comebackhere-timestamp",
    ])
  })

  it("does not send X-Idempotency-Key", async () => {
    // docs/webhooks.md documents that the live path sends no idempotency key,
    // so receivers must build their own dedupe key.
    const headers = await capture({ event: "settlement_executed", settlement_id: 1 })
    expect(headers["x-idempotency-key"]).toBeUndefined()
  })

  it("does not send X-Request-Id", async () => {
    const headers = await capture({ event: "settlement_executed", settlement_id: 1 })
    expect(headers["x-request-id"]).toBeUndefined()
  })

  it("sends a bare digest and a separate timestamp header", async () => {
    const headers = await capture({ event: "settlement_executed", settlement_id: 1 })
    expect(headers["x-comebackhere-signature"]).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sends a flat payload with an `event` field and no data envelope", async () => {
    let capturedBody = ""
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "settlement_proposed", settlement_id: 15, amount: "5000000", token: "USDC" },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>
    expect(parsed.event).toBe("settlement_proposed")
    expect(parsed).not.toHaveProperty("event_type")
    expect(parsed).not.toHaveProperty("data")
    expect(parsed).not.toHaveProperty("idempotency_key")
    expect(parsed).not.toHaveProperty("timestamp")
  })

  it("signs a signature that a consumer can still verify after re-parsing", async () => {
    // Re-serialising a parsed body must not be required: the digest is over the
    // bytes on the wire.
    let capturedBody = ""
    let capturedSignature = ""
    let capturedTimestamp = ""
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string
      const headers = init?.headers as Record<string, string>
      capturedSignature = headers[WEBHOOK_SIGNATURE_HEADER]
      capturedTimestamp = headers[WEBHOOK_TIMESTAMP_HEADER]
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await dispatchWebhook(
      TEST_URL,
      { event: "settlement_executed", settlement_id: 1, tx_hash: "abc123" },
      TEST_SECRET,
      mockFetch as unknown as typeof fetch,
    )

    expect(verifySignature(TEST_SECRET, `${capturedTimestamp}.${capturedBody}`, capturedSignature)).toBe(true)
  })
})

describe("webhook request destination safety", () => {
  it("rejects private-address and non-HTTPS targets before sending", async () => {
    const mockFetch = vi.fn()

    for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "[fe80::1]"]) {
      await expect(sendWebhookRequest(`https://${host}/hook`, {}, "{}", mockFetch as typeof fetch))
        .rejects.toThrow(/non-public/)
    }
    await expect(sendWebhookRequest("http://merchant.example/hook", {}, "{}", mockFetch as typeof fetch))
      .rejects.toThrow(/public HTTPS/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("does not follow redirects", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1/metadata" },
    }))

    const status = await sendWebhookRequest(TEST_URL, {}, "{}", mockFetch as typeof fetch)

    expect(status).toBe(302)
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" })
  })

  it("rejects every DNS answer if any answer is private", async () => {
    vi.mocked(dnsLookup).mockImplementationOnce(async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never)

    await expect(resolvePublicAddress("merchant.example")).rejects.toThrow(/non-public/)
  })

  it("rejects a hostname when DNS changes from public to private", async () => {
    vi.mocked(dnsLookup)
      .mockImplementationOnce(async () => [{ address: "1.1.1.1", family: 4 }] as never)
      .mockImplementationOnce(async () => [{ address: "10.0.0.8", family: 4 }] as never)

    await expect(resolvePublicAddress("merchant.example")).resolves.toEqual({ address: "1.1.1.1", family: 4 })
    await expect(resolvePublicAddress("merchant.example")).rejects.toThrow(/non-public/)
  })

  it("pins the socket lookup to the address validated for this request", () => {
    const lookup = createPinnedLookup({ address: "1.1.1.1", family: 4 })
    const callback = vi.fn()

    lookup("merchant.example", {}, callback)

    expect(callback).toHaveBeenCalledWith(null, "1.1.1.1", 4)
  })
})
