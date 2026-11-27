import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import { MAX_API_KEY_LENGTH, requireMerchantApiKey } from "../middleware/apiKey.js"
import { requireAdminKey } from "../middleware/adminAuth.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { errorHandler } from "../middleware/errorHandler.js"
import {
  MAX_REPORT_QUERY_LENGTH,
  MAX_REPORT_FILTER_DEPTH,
  sanitizeReportQuery,
  assertSafeReportFilter,
  requireReportAccess,
} from "../reporting-engine/security.js"

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

describe("reporting-engine hardening (auth + input boundaries)", () => {
  describe("requireReportAccess", () => {
    it("rejects unauthenticated requests", () => {
      const next = vi.fn()
      requireReportAccess({} as any, mockRes(), next)
      expect(next.mock.calls[0][0]).toMatchObject({ status: 401 })
    })

    it("rejects requests without a merchant scope", () => {
      const next = vi.fn()
      requireReportAccess({ user: { id: "u1" } } as any, mockRes(), next)
      expect(next.mock.calls[0][0]).toMatchObject({ status: 403 })
    })

    it("rejects cross-merchant access attempts", () => {
      const next = vi.fn()
      const req: any = {
        user: { id: "u1", merchantId: "merchant-a" },
        params: { merchantId: "merchant-b" },
      }
      requireReportAccess(req, mockRes(), next)
      expect(next.mock.calls[0][0]).toMatchObject({ status: 403 })
    })

    it("allows same-merchant access", () => {
      const next = vi.fn()
      const req: any = {
        user: { id: "u1", merchantId: "merchant-a" },
        params: { merchantId: "merchant-a" },
      }
      requireReportAccess(req, mockRes(), next)
      expect(next).toHaveBeenCalledWith()
    })
  })

  describe("sanitizeReportQuery", () => {
    it("rejects non-string queries", () => {
      expect(() => sanitizeReportQuery({ $ne: null } as any)).toThrow()
    })

    it("rejects oversized queries", () => {
      expect(() => sanitizeReportQuery("a".repeat(MAX_REPORT_QUERY_LENGTH + 1))).toThrow()
    })

    it("strips control characters and trims", () => {
      expect(sanitizeReportQuery("  revenue\u0000\u0007  ")).toBe("revenue")
    })

    it("neutralizes operator injection payloads", () => {
      const out = sanitizeReportQuery('{"$where":"sleep(1000)"}')
      expect(out).not.toContain("$where")
      expect(out).not.toContain("$")
    })
  })

  describe("assertSafeReportFilter", () => {
    it("rejects operator keys", () => {
      expect(() => assertSafeReportFilter({ $gt: 1 })).toThrow()
    })

    it("rejects prototype pollution keys", () => {
      expect(() => assertSafeReportFilter({ __proto__: { polluted: true } })).toThrow()
      expect(() => assertSafeReportFilter({ constructor: {} })).toThrow()
    })

    it("rejects filters nested beyond the depth limit", () => {
      let deep: any = { value: 1 }
      for (let i = 0; i < MAX_REPORT_FILTER_DEPTH + 1; i++) deep = { nested: deep }
      expect(() => assertSafeReportFilter(deep)).toThrow()
    })

    it("rejects non-plain objects", () => {
      expect(() => assertSafeReportFilter(new Date() as any)).toThrow()
      expect(() => assertSafeReportFilter([1, 2] as any)).toThrow()
    })

    it("accepts well-formed filters", () => {
      expect(() =>
        assertSafeReportFilter({ status: "paid", amount: { min: 1, max: 10 } }),
      ).not.toThrow()
    })
  })
})
