import { StrKey } from "stellar-sdk"

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

/** Rejects anything that is not a well-formed Soroban contract address (C...). */
export function assertContractId(value: unknown, label = "contract id"): string {
  if (typeof value !== "string" || !StrKey.isValidContract(value)) bad(`Invalid ${label}`)
  return value
}

/** Rejects holder addresses that are neither a valid account (G...) nor contract (C...) strkey. */
export function assertHolderAddress(value: unknown, label = "address"): string {
  if (typeof value !== "string" || !(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    bad(`Invalid ${label}`)
  }
  return value
}

/** Soroban symbols: letters, digits, underscore, at most 32 chars. */
export function assertMethodName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value)) bad("Invalid contract method name")
  return value
}

/** Maximum ledger sequence we accept; Soroban ledgers are 32-bit unsigned. */
export const MAX_LEDGER = 0xffffffff

/** Upper bound for a single page of results returned by indexers. */
export const MAX_PAGE_LIMIT = 200

/** Default page limit when none is supplied. */
export const DEFAULT_PAGE_LIMIT = 50

/** Upper bound for the number of events requested in a single call. */
export const MAX_EVENT_LIMIT = 1000

/** Maximum length of an opaque paging token. */
export const MAX_PAGING_TOKEN_LENGTH = 256

/**
 * Coerces a value to a finite integer within [min, max].
 * Rejects NaN, Infinity, non-integers, and out-of-range values with a 400.
 */
function assertIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  let parsed: number
  if (typeof value === "number") {
    parsed = value
  } else if (typeof value === "string" && value.trim() !== "") {
    // Only accept plain decimal integers; reject hex, exponents, whitespace, etc.
    if (!/^-?\d+$/.test(value.trim())) bad(`Invalid ${label}`)
    parsed = Number(value.trim())
  } else {
    bad(`Invalid ${label}`)
  }

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) bad(`Invalid ${label}`)
  if (parsed < min || parsed > max) bad(`Invalid ${label}`)
  return parsed
}

/** Validates a single ledger sequence number (0..MAX_LEDGER). */
export function assertLedgerSequence(value: unknown, label = "ledger sequence"): number {
  return assertIntegerInRange(value, 0, MAX_LEDGER, label)
}

/**
 * Validates a ledger range. Both bounds must be valid ledger sequences and
 * `from` must not exceed `to`. Returns the normalized inclusive range.
 */
export function assertLedgerRange(
  from: unknown,
  to: unknown,
  label = "ledger range",
): { from: number; to: number } {
  const start = assertLedgerSequence(from, `${label} start`)
  const end = assertLedgerSequence(to, `${label} end`)
  if (start > end) bad(`Invalid ${label}: start must not exceed end`)
  return { from: start, to: end }
}

/**
 * Validates a paging token. Tokens are opaque, non-empty strings of bounded
 * length composed of URL-safe characters. `undefined`/`null` are allowed and
 * normalized to `undefined` (meaning "start from the beginning").
 */
export function assertPagingToken(value: unknown, label = "paging token"): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") bad(`Invalid ${label}`)
  const trimmed = value.trim()
  if (trimmed.length === 0) bad(`Invalid ${label}`)
  if (trimmed.length > MAX_PAGING_TOKEN_LENGTH) bad(`Invalid ${label}`)
  // URL-safe base64-ish / alphanumeric tokens with optional separators.
  if (!/^[A-Za-z0-9_\-.:=+/]+$/.test(trimmed)) bad(`Invalid ${label}`)
  return trimmed
}

/**
 * Validates a page limit. Accepts 1..MAX_PAGE_LIMIT. When omitted, returns
 * DEFAULT_PAGE_LIMIT.
 */
export function assertPageLimit(value: unknown, label = "page limit"): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_LIMIT
  return assertIntegerInRange(value, 1, MAX_PAGE_LIMIT, label)
}

/**
 * Validates an event limit. Accepts 1..MAX_EVENT_LIMIT. When omitted, returns
 * DEFAULT_PAGE_LIMIT.
 */
export function assertEventLimit(value: unknown, label = "event limit"): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_LIMIT
  return assertIntegerInRange(value, 1, MAX_EVENT_LIMIT, label)
}

/**
 * Validates a non-negative integer within [0, max]. Useful for offsets,
 * cursors, and counters used by the reporting-engine indexers.
 */
export function assertNonNegativeInteger(
  value: unknown,
  max: number = Number.MAX_SAFE_INTEGER,
  label = "value",
): number {
  if (!Number.isFinite(max) || max < 0) bad(`Invalid ${label} bound`)
  return assertIntegerInRange(value, 0, Math.floor(max), label)
}

/**
 * Validates a finite number within [min, max]. Rejects NaN and Infinity.
 * Useful for numeric bounds (amounts, thresholds) in reporting queries.
 */
export function assertFiniteNumberInRange(
  value: unknown,
  min: number,
  max: number,
  label = "value",
): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) bad(`Invalid ${label} bounds`)
  let parsed: number
  if (typeof value === "number") {
    parsed = value
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value.trim())
  } else {
    bad(`Invalid ${label}`)
  }
  if (!Number.isFinite(parsed)) bad(`Invalid ${label}`)
  if (parsed < min || parsed > max) bad(`Invalid ${label}`)
  return parsed
}