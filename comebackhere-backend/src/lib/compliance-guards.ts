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
