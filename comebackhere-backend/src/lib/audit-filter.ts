/**
 * Input-boundary helpers for the compliance audit trail routes.
 * (`audit-logger` is mapped to routes/compliance.ts + services/compliance-indexer.ts.)
 */

/** Deepest `skip` value accepted by the audit listing, to bound MongoDB scan cost. */
export const MAX_AUDIT_SKIP = 100_000

const AUDIT_EVENT_TYPES = new Set(["address_allowed", "address_allowed_until", "address_blocked", "address_cleared"])

export interface AuditFilterInput {
  address?: unknown
  event_type?: unknown
  from_ledger?: unknown
  to_ledger?: unknown
}

/**
 * Builds a MongoDB filter using only primitive, type-checked values so that
 * operator objects (e.g. `address[$ne]=x`) can never reach the driver.
 */
export function buildAuditFilter(query: AuditFilterInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (typeof query.address === "string" && query.address) filter.address = query.address
  if (typeof query.event_type === "string" && AUDIT_EVENT_TYPES.has(query.event_type)) {
    filter.event_type = query.event_type
  }
  const from = typeof query.from_ledger === "number" && Number.isFinite(query.from_ledger) ? query.from_ledger : undefined
  const to = typeof query.to_ledger === "number" && Number.isFinite(query.to_ledger) ? query.to_ledger : undefined
  if (from !== undefined || to !== undefined) {
    filter.ledger = {
      ...(from !== undefined ? { $gte: from } : {}),
      ...(to !== undefined ? { $lte: to } : {}),
    }
  }
  return filter
}

/** Returns true when the requested page would skip beyond the supported depth. */
export function exceedsAuditSkip(skip: number): boolean {
  return !Number.isFinite(skip) || skip > MAX_AUDIT_SKIP
}
