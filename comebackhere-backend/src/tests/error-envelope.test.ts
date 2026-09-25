import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { toAppError } from "../middleware/errorHandler.js"
import { AppError, ContractError, NotFoundError, ValidationError } from "../lib/errors.js"

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
})
