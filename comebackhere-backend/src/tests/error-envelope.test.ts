import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { toAppError } from "../middleware/errorHandler.js"
import { AppError, ContractError, NotFoundError, ValidationError } from "../lib/errors.js"
import { isValidStellarAddress, validateAuthPayload } from "../lib/authValidation.js"

function expectEnvelope(body: any) {
  expect(Object.keys(body)).toEqual(["error"])
  expect(Object.keys(body.error).sort()).toEqual(["code", "correlationId", "details", "message"])
  expect(typeof body.error.code).toBe("string")
  expect(typeof body.error.message).toBe("string")
}

describe("standard error envelope", () => {
  const app = createApp()

  it("wraps zod validation failures with field-level details", async () => {
    const res = await request(app)
      .post("/api/treasury/threshold")
      .set("X-Request-Id", "req-validation")
      .send({ threshold: -1 })

    expect(res.status).toBe(400)
    expectEnvelope(res.body)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(res.body.error.correlationId).toBe("req-validation")
    expect(res.body.error.details).toEqual([{ field: "threshold", message: "Must be a positive integer" }])
  })

  it("returns 404 NOT_FOUND for unknown routes", async () => {
    const res = await request(app).get("/nope")
    expect(res.status).toBe(404)
    expectEnvelope(res.body)
    expect(res.body.error.code).toBe("NOT_FOUND")
    expect(res.body.error.correlationId).toBe(res.headers["x-request-id"])
  })

  it("returns 400 INVALID_JSON for malformed JSON bodies", async () => {
    const res = await request(app)
      .post("/api/treasury/threshold")
      .set("Content-Type", "application/json")
      .send("{not json")

    expect(res.status).toBe(400)
    expectEnvelope(res.body)
    expect(res.body.error.code).toBe("INVALID_JSON")
    expect(res.body.error.correlationId).toBe(res.headers["x-request-id"])
  })

  describe("missing env vars", () => {
    let backup: string | undefined
    beforeEach(() => {
      backup = process.env.SOROBAN_RPC_URL
      delete process.env.SOROBAN_RPC_URL
    })
    afterEach(() => {
      if (backup !== undefined) process.env.SOROBAN_RPC_URL = backup
    })

    it("returns 503 SERVICE_MISCONFIGURED", async () => {
      const res = await request(app).get("/api/treasury/threshold")
      expect(res.status).toBe(503)
      expectEnvelope(res.body)
      expect(res.body.error.code).toBe("SERVICE_MISCONFIGURED")
      expect(res.body.error.details).toBeNull()
    })
  })
})

describe("toAppError", () => {
  it("passes typed errors through unchanged", () => {
    const err = new NotFoundError("gone")
    expect(toAppError(err)).toBe(err)
    expect(new ValidationError("bad").status).toBe(400)
  })

  it("maps legacy status-tagged errors to a code by status", () => {
    const err = toAppError(Object.assign(new Error("Transaction confirmation timeout"), { status: 504 }))
    expect(err).toBeInstanceOf(AppError)
    expect(err.status).toBe(504)
    expect(err.code).toBe("GATEWAY_TIMEOUT")
    expect(err.message).toBe("Transaction confirmation timeout")
  })

  it("extracts the contract code from Soroban host errors", () => {
    const err = toAppError(
      Object.assign(new Error("Soroban simulation failed: HostError: Error(Contract, #7) INSUFFICIENT_BALANCE"), {
        status: 422,
      }),
    )
    expect(err).toBeInstanceOf(ContractError)
    expect(err.status).toBe(422)
    expect(err.code).toBe("CONTRACT_ERROR")
    expect(err.details).toEqual({ contractCode: 7 })
  })

  it("defaults unknown errors to 500 INTERNAL_ERROR", () => {
    const err = toAppError("boom")
    expect(err.status).toBe(500)
    expect(err.code).toBe("INTERNAL_ERROR")
  })

  it("handles null and undefined errors defensively", () => {
    for (const value of [null, undefined]) {
      const err = toAppError(value)
      expect(err).toBeInstanceOf(AppError)
      expect(err.status).toBe(500)
      expect(err.code).toBe("INTERNAL_ERROR")
      expect(typeof err.message).toBe("string")
    }
  })

  it("does not throw when reading hostile error objects", () => {
    const hostile = Object.create(null)
    Object.defineProperty(hostile, "status", {
      get() {
        throw new Error("boom")
      },
    })
    const err = toAppError(hostile)
    expect(err.status).toBe(500)
    expect(err.code).toBe("INTERNAL_ERROR")
  })
})

describe("auth-service validation", () => {
  describe("isValidStellarAddress", () => {
    it("accepts well-formed Stellar addresses", () => {
      expect(isValidStellarAddress("GA" + "A".repeat(54))).toBe(true)
    })

    it("rejects null, undefined and non-string inputs", () => {
      for (const value of [null, undefined, 42, {}, []]) {
        expect(isValidStellarAddress(value as any)).toBe(false)
      }
    })

    it("rejects malformed addresses", () => {
      expect(isValidStellarAddress("")).toBe(false)
      expect(isValidStellarAddress("not-an-address")).toBe(false)
      expect(isValidStellarAddress("GA" + "A".repeat(53))).toBe(false)
      expect(isValidStellarAddress("GA" + "A".repeat(55))).toBe(false)
      expect(isValidStellarAddress("XA" + "A".repeat(54))).toBe(false)
      expect(isValidStellarAddress("GA" + "0".repeat(54))).toBe(false)
    })
  })

  describe("validateAuthPayload", () => {
    const valid = { address: "GA" + "A".repeat(54), nonce: "abc123", signature: "sig" }

    it("accepts a valid payload", () => {
      expect(validateAuthPayload(valid)).toEqual({ ok: true })
    })

    it("rejects null and undefined payloads", () => {
      for (const value of [null, undefined]) {
        const result = validateAuthPayload(value as any)
        expect(result.ok).toBe(false)
      }
    })

    it("reports field-level errors for malformed addresses", () => {
      const result = validateAuthPayload({ ...valid, address: "bad" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.details).toEqual([{ field: "address", message: expect.any(String) }])
      }
    })

    it("rejects oversized values", () => {
      const result = validateAuthPayload({ ...valid, nonce: "n".repeat(4096), signature: "s".repeat(4096) })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        const fields = result.details.map((d) => d.field)
        expect(fields).toContain("nonce")
        expect(fields).toContain("signature")
      }
    })
  })

  describe("auth endpoints", () => {
    const app = createApp()

    it("returns a typed VALIDATION_ERROR envelope for null bodies", async () => {
      const res = await request(app)
        .post("/api/auth/verify")
        .set("X-Request-Id", "req-auth-null")
        .set("Content-Type", "application/json")
        .send("null")

      expect(res.status).toBe(400)
      expectEnvelope(res.body)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
      expect(res.body.error.correlationId).toBe("req-auth-null")
      expect(Array.isArray(res.body.error.details)).toBe(true)
    })

    it("returns a typed VALIDATION_ERROR envelope for malformed addresses", async () => {
      const res = await request(app)
        .post("/api/auth/verify")
        .set("X-Request-Id", "req-auth-address")
        .send({ address: "bad", nonce: "abc", signature: "sig" })

      expect(res.status).toBe(400)
      expectEnvelope(res.body)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "address" })]),
      )
    })

    it("returns a typed VALIDATION_ERROR envelope for oversized values", async () => {
      const res = await request(app)
        .post("/api/auth/verify")
        .set("X-Request-Id", "req-auth-oversized")
        .send({ address: "GA" + "A".repeat(54), nonce: "n".repeat(4096), signature: "s".repeat(4096) })

      expect(res.status).toBe(400)
      expectEnvelope(res.body)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })

    it("returns a typed INVALID_JSON envelope for malformed JSON", async () => {
      const res = await request(app)
        .post("/api/auth/verify")
        .set("Content-Type", "application/json")
        .send("{not json")

      expect(res.status).toBe(400)
      expectEnvelope(res.body)
      expect(res.body.error.code).toBe("INVALID_JSON")
    })
  })
})
