import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import { MAX_API_KEY_LENGTH, requireMerchantApiKey } from "../middleware/apiKey.js"
import { requireAdminKey } from "../middleware/adminAuth.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { errorHandler } from "../middleware/errorHandler.js"

function mockRes() {
  const res: any = { locals: {}, headersSent: false }
  res.status = vi.fn(() => res)
  res.json = vi.fn(() => res)
  return res
}

describe("api-gateway hardening (gateway middleware)", () => {
  it("rejects oversized bearer keys without touching the DB", () => {
    const req: any = { get: () => `Bearer ${"a".repeat(MAX_API_KEY_LENGTH + 1)}` }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("reports (root) for root-level validation failures", () => {
    const next = vi.fn()
    validateBody(z.object({ a: z.string() }))({ body: "x" } as any, mockRes(), next)
    expect(next.mock.calls[0][0].message).toContain("(root)")
  })

  it("writes parsed params back onto the request", () => {
    const req: any = { params: { n: "5" } }
    const next = vi.fn()
    validateParams(z.object({ n: z.coerce.number() }))(req, mockRes(), next)
    expect(req.params.n).toBe(5)
  })

  it("masks unexpected 5xx error messages", () => {
    const res = mockRes()
    errorHandler(new Error("mongo connection string leaked"), {} as any, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json.mock.calls[0][0].error.message).toBe("Internal server error")
  })
})

describe("apiKey middleware hardening", () => {
  const originalEnv = process.env.MERCHANT_API_KEY

  beforeEach(() => {
    process.env.MERCHANT_API_KEY = "valid-merchant-key-123"
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MERCHANT_API_KEY
    else process.env.MERCHANT_API_KEY = originalEnv
  })

  it("rejects requests with no Authorization header", () => {
    const req: any = { get: () => undefined }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects malformed Authorization headers (missing Bearer prefix)", () => {
    const req: any = { get: () => "valid-merchant-key-123" }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects keys containing control characters", () => {
    const req: any = { get: () => "Bearer valid-merchant-key-123\u0000" }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects oversized keys before comparison", () => {
    const req: any = { get: () => `Bearer ${"a".repeat(MAX_API_KEY_LENGTH + 1)}` }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("fails closed when server config is missing", () => {
    delete process.env.MERCHANT_API_KEY
    const req: any = { get: () => "Bearer valid-merchant-key-123" }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 500 })
  })

  it("accepts a correctly formed matching key", () => {
    const req: any = { get: () => "Bearer valid-merchant-key-123" }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next).toHaveBeenCalledWith()
  })

  it("rejects a non-matching key of equal length", () => {
    const req: any = { get: () => "Bearer valid-merchant-key-999" }
    const next = vi.fn()
    requireMerchantApiKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })
})

describe("adminAuth middleware hardening", () => {
  const originalEnv = process.env.ADMIN_API_KEY

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "valid-admin-key-456"
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADMIN_API_KEY
    else process.env.ADMIN_API_KEY = originalEnv
  })

  it("rejects requests with no Authorization header", () => {
    const req: any = { get: () => undefined }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects malformed Authorization headers (missing Bearer prefix)", () => {
    const req: any = { get: () => "valid-admin-key-456" }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects keys containing control characters", () => {
    const req: any = { get: () => "Bearer valid-admin-key-456\n" }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("rejects oversized keys", () => {
    const req: any = { get: () => `Bearer ${"a".repeat(MAX_API_KEY_LENGTH + 1)}` }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it("fails closed when server config is missing", () => {
    delete process.env.ADMIN_API_KEY
    const req: any = { get: () => "Bearer valid-admin-key-456" }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 500 })
  })

  it("accepts a correctly formed matching key", () => {
    const req: any = { get: () => "Bearer valid-admin-key-456" }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next).toHaveBeenCalledWith()
  })

  it("rejects a non-matching key of equal length", () => {
    const req: any = { get: () => "Bearer valid-admin-key-999" }
    const next = vi.fn()
    requireAdminKey(req, mockRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
  })
})
