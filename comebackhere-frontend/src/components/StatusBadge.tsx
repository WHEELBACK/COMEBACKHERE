import type { InvoiceStatus } from "../types"

interface StatusBadgeProps {
  status: InvoiceStatus
}

const statusColors: Record<string, string> = {
  Pending: "badge badge--pending",
  Paid: "badge badge--paid",
  Expired: "badge badge--expired",
  Cancelled: "badge badge--cancelled",
  RefundRequested: "badge badge--refund-requested",
  Released: "badge badge--released",
  OnHold: "badge badge--on-hold",
}

/** Human-readable label for each status, so "OnHold" shows as "On Hold". */
const statusLabels: Record<string, string> = {
  Pending: "Pending",
  Paid: "Paid",
  Expired: "Expired",
  Cancelled: "Cancelled",
  RefundRequested: "Refund Requested",
  Released: "Released",
  OnHold: "On Hold",
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = statusLabels[status] ?? status
  return (
    <span className={statusColors[status] ?? "badge"} role="status" aria-label={`Invoice status: ${label}`}>{label}</span>
  )
}
