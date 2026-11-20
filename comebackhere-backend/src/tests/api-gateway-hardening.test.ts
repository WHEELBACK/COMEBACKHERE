import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { MAX_API_KEY_LENGTH, requireMerchantApiKey } from "../middleware/apiKey.js"
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
