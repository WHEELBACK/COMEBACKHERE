import type { SorobanRpc, xdr } from "stellar-sdk"

type RpcEventLike = Awaited<ReturnType<SorobanRpc.Server["getEvents"]>>["events"][number]

/** Validates a time-bound allowance expiry (Unix seconds, positive safe integer). */
export function isValidAllowanceExpiry(until: unknown): until is number {
  return typeof until === "number" && Number.isSafeInteger(until) && until > 0
}

/** Rejects empty or non-string account addresses before building a transaction. */
export function assertNonEmptyAddress(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error("A non-empty address is required"), { status: 400 })
  }
}

/**
 * Runs an event parser and returns null instead of throwing when the event is
 * malformed, so one poison event cannot stall the whole indexer batch.
 */
export function tryParseEvent<T>(event: RpcEventLike, parse: (e: RpcEventLike) => T): T | null {
  try {
    return parse(event)
  } catch {
    return null
  }
}

export type { xdr }

const STATUS_BY_EVENT: Record<string, "Allowed" | "AllowedUntil" | "Blocked" | "Cleared"> = {
  address_allowed: "Allowed",
  address_allowed_until: "AllowedUntil",
  address_blocked: "Blocked",
  address_cleared: "Cleared",
}

/** Maps an indexed compliance event type to its audit status (previously undefined at runtime). */
export function complianceStatusForEvent(eventType: string): "Allowed" | "AllowedUntil" | "Blocked" | "Cleared" {
  const status = STATUS_BY_EVENT[eventType]
  if (!status) throw new Error(`Unknown compliance event type: ${eventType}`)
  return status
}

const STELLAR_ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/
const MAX_REPORT_REASON_LENGTH = 512

/**
 * Validates a Stellar account (G...) or contract (C...) address before it is
 * used in compliance lookups or persisted in reports. Rejects anything that is
 * not a plain base32 strkey so untrusted input cannot smuggle in injection
 * payloads or unexpected characters.
 */
export function assertValidComplianceAddress(value: unknown): asserts value is string {
  if (typeof value !== "string" || !STELLAR_ADDRESS_PATTERN.test(value)) {
    throw Object.assign(new Error("A valid Stellar address is required"), { status: 400 })
  }
}

/** Returns true when the value is a well-formed Stellar address. */
export function isValidComplianceAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_PATTERN.test(value)
}

/**
 * Normalizes and validates a free-text compliance report reason. Strips control
 * characters, trims, enforces a length bound, and rejects empty results so the
 * value is safe to persist and render.
 */
export function sanitizeReportReason(value: unknown): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error("A report reason is required"), { status: 400 })
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (cleaned === "") {
    throw Object.assign(new Error("A report reason is required"), { status: 400 })
  }
  if (cleaned.length > MAX_REPORT_REASON_LENGTH) {
    throw Object.assign(new Error("Report reason is too long"), { status: 400 })
  }
  return cleaned
}

/**
 * Validates a pagination limit for compliance queries, clamping to a safe
 * range so callers cannot request unbounded result sets.
 */
export function sanitizePaginationLimit(value: unknown, fallback = 50, max = 200): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(parsed, max)
}
