import { describe, it, expect } from "vitest"
import { validateIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH } from "../lib/idempotency-key.js"
import { ValidationError } from "../lib/errors.js"

describe("validateIdempotencyKey", () => {
  it("accepts uuid-like keys", () => {
    expect(validateIdempotencyKey("3f2b9c1e-aa:b_c.d")).toBe("3f2b9c1e-aa:b_c.d")
  })
  it("rejects over-long keys", () => {
    expect(() => validateIdempotencyKey("a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toThrow(ValidationError)
  })
  it("rejects unsafe characters", () => {
    expect(() => validateIdempotencyKey("key with space")).toThrow(ValidationError)
    expect(() => validateIdempotencyKey("a\u0000b")).toThrow(ValidationError)
    expect(() => validateIdempotencyKey("k*")).toThrow(ValidationError)
  })
})
