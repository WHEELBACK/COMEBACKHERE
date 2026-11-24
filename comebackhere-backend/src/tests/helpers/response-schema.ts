import type { ZodType } from "zod"

export function expectResponseShape<T>(body: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`Response shape mismatch: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Validates that a response body matches the given schema and returns the
 * parsed data. Throws a descriptive error including the provided context
 * label when validation fails, which helps pinpoint the failing endpoint
 * or payload in integration tests.
 */
export function expectReportingResponseShape<T>(
  body: unknown,
  schema: ZodType<T>,
  context = "reporting-engine response"
): T {
  if (body === null || body === undefined) {
    throw new Error(`${context}: expected a response body but received ${String(body)}`)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`${context} shape mismatch: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Validates an array of response bodies against the given schema, returning
 * the parsed array. Useful for list endpoints in reporting-engine where each
 * item must conform to the same shape.
 */
export function expectReportingResponseListShape<T>(
  body: unknown,
  schema: ZodType<T>,
  context = "reporting-engine response list"
): T[] {
  if (!Array.isArray(body)) {
    throw new Error(`${context}: expected an array but received ${typeof body}`)
  }

  return body.map((item, index) => {
    const parsed = schema.safeParse(item)
    if (!parsed.success) {
      throw new Error(`${context} item[${index}] shape mismatch: ${parsed.error.message}`)
    }
    return parsed.data
  })
}

/**
 * Asserts that a response body matches the given schema without returning the
 * parsed data. Throws a descriptive error on mismatch.
 */
export function assertReportingResponseShape<T>(
  body: unknown,
  schema: ZodType<T>,
  context = "reporting-engine response"
): void {
  expectReportingResponseShape(body, schema, context)
}