/**
 * Idempotency key validation — boolean predicate variant.
 *
 * Re-exports validateIdempotencyKey as a boolean-returning function so that
 * callers can branch on validity without catching an exception.
 */

const MAX_IDEMPOTENCY_KEY_LEN = 256
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * Returns true when `value` is a non-empty string that:
 *  - does not exceed MAX_IDEMPOTENCY_KEY_LEN characters
 *  - contains only alphanumerics, dots, underscores, colons, and hyphens
 */
export function validateIdempotencyKey(value: unknown): boolean {
  if (typeof value !== "string") return false
  if (value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LEN) return false
  return IDEMPOTENCY_KEY_PATTERN.test(value)
}
