import { ValidationError } from "./errors.js"

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const KEY_PATTERN = /^[A-Za-z0-9._:\-]+$/

/** Validates a client-supplied Idempotency-Key; throws ValidationError when malformed. */
export function validateIdempotencyKey(raw: string): string {
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  }
  if (!KEY_PATTERN.test(raw)) {
    throw new ValidationError("Idempotency-Key may only contain letters, digits, '.', '_', ':' and '-'")
  }
  return raw
}
