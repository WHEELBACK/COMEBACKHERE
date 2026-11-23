import { StrKey } from '@stellar/stellar-sdk';

/**
 * Typed error hierarchy for the auth-service.
 *
 * These errors are intentionally small and dependency-free so that they can be
 * thrown from low-level guards and reliably detected by callers (e.g. the HTTP
 * layer) without leaking implementation details.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    // Restore prototype chain for transpiled targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.field = field;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

/**
 * Default bounds. Kept as exported constants so tests and callers can reason
 * about the limits without duplicating magic numbers.
 */
export const LIMITS = {
  /** Generic short identifier (e.g. usernames, nonces). */
  SHORT_STRING_MAX: 256,
  /** Longer free-form strings (e.g. display names, metadata). */
  LONG_STRING_MAX: 2048,
  /** Idempotency keys are typically UUID-ish; allow a little headroom. */
  IDEMPOTENCY_KEY_MAX: 255,
  /** Session tokens (JWTs / opaque tokens). */
  SESSION_TOKEN_MAX: 8192,
} as const;

/**
 * Returns true when the value is a non-empty string (after trimming) that does
 * not exceed `maxLength` characters.
 */
function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

/**
 * Validates a required, non-empty, bounded string.
 *
 * @throws {ValidationError} when the value is null/undefined, not a string,
 *   empty/whitespace-only, or exceeds `maxLength`.
 */
export function validateNonEmptyString(
  value: unknown,
  field: string,
  maxLength: number = LIMITS.SHORT_STRING_MAX,
): string {
  if (value === null || value === undefined) {
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, field);
  }
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`, field);
  }
  if (value.length > maxLength) {
    throw new ValidationError(
      `${field} must be at most ${maxLength} characters`,
      field,
    );
  }
  return value;
}

/**
 * Validates an optional bounded string. Returns `undefined` when the value is
 * null/undefined; otherwise applies the same rules as `validateNonEmptyString`.
 */
export function validateOptionalString(
  value: unknown,
  field: string,
  maxLength: number = LIMITS.SHORT_STRING_MAX,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return validateNonEmptyString(value, field, maxLength);
}

/**
 * Validates a Stellar account address (ed25519 public key) using StrKey.
 *
 * @throws {ValidationError} when the value is missing, malformed, or not a
 *   valid Stellar `G...` account address.
 */
export function validateStellarAddress(
  value: unknown,
  field = 'address',
): string {
  const address = validateNonEmptyString(value, field, 56);
  let isValid = false;
  try {
    isValid = StrKey.isValidEd25519PublicKey(address);
  } catch {
    // StrKey can throw on pathological input; treat as invalid.
    isValid = false;
  }
  if (!isValid) {
    throw new ValidationError(`${field} is not a valid Stellar address`, field);
  }
  return address;
}

/**
 * Validates an idempotency key.
 *
 * Idempotency keys must be non-empty, bounded, and restricted to a safe
 * character set (alphanumerics plus `-`, `_`, `.`, `:`). This prevents header
 * injection and unbounded cache-key growth under load.
 *
 * @throws {ValidationError} when the key is missing, oversized, or contains
 *   disallowed characters.
 */
export function validateIdempotencyKey(
  value: unknown,
  field = 'idempotencyKey',
): string {
  const key = validateNonEmptyString(value, field, LIMITS.IDEMPOTENCY_KEY_MAX);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ValidationError(
      `${field} contains invalid characters`,
      field,
    );
  }
  return key;
}

/**
 * Validates a timestamp expressed as either a `Date`, epoch milliseconds
 * (number), or an ISO-8601 string. Returns a `Date` instance.
 *
 * @throws {ValidationError} when the value is missing, unparseable, or outside
 *   the representable range.
 */
export function validateTimestamp(
  value: unknown,
  field = 'timestamp',
): Date {
  if (value === null || value === undefined) {
    throw new ValidationError(`${field} is required`, field);
  }

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${field} must be a finite number`, field);
    }
    date = new Date(value);
  } else if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new ValidationError(`${field} must not be empty`, field);
    }
    date = new Date(value);
  } else {
    throw new ValidationError(
      `${field} must be a Date, number, or ISO-8601 string`,
      field,
    );
  }

  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} is not a valid timestamp`, field);
  }
  return date;
}

/**
 * Validates a session token. Tokens must be non-empty, bounded, and free of
 * whitespace/control characters (which would indicate a malformed or injected
 * header value).
 *
 * @throws {ValidationError} when the token is missing, oversized, or contains
 *   whitespace/control characters.
 */
export function validateSessionToken(
  value: unknown,
  field = 'sessionToken',
): string {
  const token = validateNonEmptyString(value, field, LIMITS.SESSION_TOKEN_MAX);
  // Reject any whitespace or ASCII control characters.
  if (/[\s\u0000-\u001F\u007F]/.test(token)) {
    throw new ValidationError(
      `${field} contains invalid characters`,
      field,
    );
  }
  return token;
}

/**
 * Wraps a synchronous or asynchronous operation, converting any unexpected
 * throw into a typed `AppError`. Existing `AppError` instances are re-thrown
 * unchanged so that specific error codes/statuses are preserved.
 *
 * This is the primary defensive boundary used by the auth-service to ensure
 * that edge-case failures under load surface as predictable, typed errors
 * rather than raw exceptions.
 */
export async function safeTry<T>(
  fn: () => T | Promise<T>,
  fallbackMessage = 'Unexpected error',
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    const message =
      err instanceof Error && err.message
        ? `${fallbackMessage}: ${err.message}`
        : fallbackMessage;
    throw new AppError(message, 'INTERNAL_ERROR', 500);
  }
}

/**
 * Synchronous variant of `safeTry` for hot paths that cannot await.
 */
export function safeTrySync<T>(
  fn: () => T,
  fallbackMessage = 'Unexpected error',
): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    const message =
      err instanceof Error && err.message
        ? `${fallbackMessage}: ${err.message}`
        : fallbackMessage;
    throw new AppError(message, 'INTERNAL_ERROR', 500);
  }
}

/**
 * Convenience guard used by request handlers: ensures a value is present and
 * throws `UnauthorizedError` otherwise. Useful for session/credential checks.
 */
export function requirePresent<T>(
  value: T | null | undefined,
  message = 'Unauthorized',
): T {
  if (value === null || value === undefined) {
    throw new UnauthorizedError(message);
  }
  return value;
}

// Re-export the internal helper for tests that need to assert bounds behavior.
export const __internal = { isBoundedNonEmptyString };
```

```typescript
// comebackhere-backend/src/lib/__tests__/auth-guards.test.ts
import {
  AppError,
  UnauthorizedError,
  ValidationError,
  LIMITS,
  validateNonEmptyString,
  validateOptionalString,
  validateStellarAddress,
  validateIdempotencyKey,
  validateTimestamp,
  validateSessionToken,
  safeTry,
  safeTrySync,
  requirePresent,
} from '../auth-guards';

// A known-valid Stellar ed25519 public key (zero-filled payload).
const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('auth-guards', () => {
  describe('validateNonEmptyString', () => {
    it('returns valid strings unchanged', () => {
      expect(validateNonEmptyString('hello', 'name')).toBe('hello');
    });

    it('throws on null and undefined', () => {
      expect(() => validateNonEmptyString(null, 'name')).toThrow(ValidationError);
      expect(() => validateNonEmptyString(undefined, 'name')).toThrow(ValidationError);
    });

    it('throws on empty and whitespace-only strings', () => {
      expect(() => validateNonEmptyString('', 'name')).toThrow(ValidationError);
      expect(() => validateNonEmptyString('   ', 'name')).toThrow(ValidationError);
    });

    it('throws on non-string values', () => {
      expect(() => validateNonEmptyString(42, 'name')).toThrow(ValidationError);
      expect(() => validateNonEmptyString({}, 'name')).toThrow(ValidationError);
    });

    it('throws on oversized values', () => {
      const oversized = 'a'.repeat(LIMITS.SHORT_STRING_MAX + 1);
      expect(() => validateNonEmptyString(oversized, 'name')).toThrow(ValidationError);
    });

    it('includes the field name in the error', () => {
      try {
        validateNonEmptyString(null, 'username');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('username');
        expect((err as ValidationError).statusCode).toBe(400);
      }
    });
  });

  describe('validateOptionalString', () => {
    it('returns undefined for null/undefined', () => {
      expect(validateOptionalString(null, 'name')).toBeUndefined();
      expect(validateOptionalString(undefined, 'name')).toBeUndefined();
    });

    it('validates present values', () => {
      expect(validateOptionalString('ok', 'name')).toBe('ok');
      expect(() => validateOptionalString('', 'name')).toThrow(ValidationError);
    });
  });

  describe('validateStellarAddress', () => {
    it('accepts a valid address', () => {
      expect(validateStellarAddress(VALID_ADDRESS)).toBe(VALID_ADDRESS);
    });

    it('throws on null/undefined', () => {
      expect(() => validateStellarAddress(null)).toThrow(ValidationError);
      expect(() => validateStellarAddress(undefined)).toThrow(ValidationError);
    });

    it('throws on malformed addresses', () => {
      expect(() => validateStellarAddress('not-an-address')).toThrow(ValidationError);
      expect(() => validateStellarAddress('G'.repeat(56))).toThrow(ValidationError);
      expect(() => validateStellarAddress('S' + VALID_ADDRESS.slice(1))).toThrow(
        ValidationError,
      );
    });

    it('throws on oversized input', () => {
      expect(() => validateStellarAddress('G'.repeat(200))).toThrow(ValidationError);
    });
  });

  describe('validateIdempotencyKey', () => {
    it('accepts safe keys', () => {
      expect(validateIdempotencyKey('abc-123_def.ghi:jkl')).toBe('abc-123_def.ghi:jkl');
    });

    it('throws on null/undefined/empty', () => {
      expect(() => validateIdempotencyKey(null)).toThrow(ValidationError);
      expect(() => validateIdempotencyKey(undefined)).toThrow(ValidationError);
      expect(() => validateIdempotencyKey('')).toThrow(ValidationError);
    });

    it('throws on oversized keys', () => {
      const oversized = 'a'.repeat(LIMITS.IDEMPOTENCY_KEY_MAX + 1);
      expect(() => validateIdempotencyKey(oversized)).toThrow(ValidationError);
    });

    it('throws on disallowed characters', () => {
      expect(() => validateIdempotencyKey('bad key')).toThrow(ValidationError);
      expect(() => validateIdempotencyKey('bad\nkey')).toThrow(ValidationError);
      expect(() => validateIdempotencyKey('bad/key')).toThrow(ValidationError);
    });
  });

  describe('validateTimestamp', () => {
    it('accepts Date, number, and ISO strings', () => {
      const now = new Date();
      expect(validateTimestamp(now).getTime()).toBe(now.getTime());
      expect(validateTimestamp(now.getTime()).getTime()).toBe(now.getTime());
      expect(validateTimestamp(now.toISOString()).getTime()).toBe(now.getTime());
    });

    it('throws on null/undefined', () => {
      expect(() => validateTimestamp(null)).toThrow(ValidationError);
      expect(() => validateTimestamp(undefined)).toThrow(ValidationError);
    });

    it('throws on invalid values', () => {
      expect(() => validateTimestamp('not-a-date')).toThrow(ValidationError);
      expect(() => validateTimestamp(NaN)).toThrow(ValidationError);
      expect(() => validateTimestamp(Infinity)).toThrow(ValidationError);
      expect(() => validateTimestamp({})).toThrow(ValidationError);
    });
  });

  describe('validateSessionToken', () => {
    it('accepts a typical token', () => {
      expect(validateSessionToken('abc.def.ghi')).toBe('abc.def.ghi');
    });

    it('throws on null/undefined/empty', () => {
      expect(() => validateSessionToken(null)).toThrow(ValidationError);
      expect(() => validateSessionToken(undefined)).toThrow(ValidationError);
      expect(() => validateSessionToken('')).toThrow(ValidationError);
    });

    it('throws on oversized tokens', () => {
      const oversized = 'a'.repeat(LIMITS.SESSION_TOKEN_MAX + 1);
      expect(() => validateSessionToken(oversized)).toThrow(ValidationError);
    });

    it('throws on whitespace/control characters', () => {
      expect(() => validateSessionToken('has space')).toThrow(ValidationError);
      expect(() => validateSessionToken('has\nnewline')).toThrow(ValidationError);
      expect(() => validateSessionToken('has\u0000null')).toThrow(ValidationError);
    });
  });

  describe('safeTry', () => {
    it('returns the resolved value', async () => {
      await expect(safeTry(() => 42)).resolves.toBe(42);
      await expect(safeTry(async () => 'ok')).resolves.toBe('ok');
    });

    it('re-throws AppError instances unchanged', async () => {
      const original = new ValidationError('bad', 'field');
      await expect(
        safeTry(() => {
          throw original;
        }),
      ).rejects.toBe(original);
    });

    it('converts unexpected throws into AppError', async () => {
      await expect(
        safeTry(() => {
          throw new Error('boom');
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    });

    it('handles non-Error throws', async () => {
      await expect(
        safeTry(() => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string-throw';
        }),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('safeTrySync', () => {
    it('returns the value', () => {
      expect(safeTrySync(() => 7)).toBe(7);
    });

    it('converts unexpected throws into AppError', () => {
      expect(() =>
        safeTrySync(() => {
          throw new Error('boom');
        }),
      ).toThrow(AppError);
    });
  });

  describe('requirePresent', () => {
    it('returns present values', () => {
      expect(requirePresent('x')).toBe('x');
      expect(requirePresent(0)).toBe(0);
    });

    it('throws UnauthorizedError on null/undefined', () => {
      expect(() => requirePresent(null)).toThrow(UnauthorizedError);
      expect(() => requirePresent(undefined)).toThrow(UnauthorizedError);
    });
  });
});