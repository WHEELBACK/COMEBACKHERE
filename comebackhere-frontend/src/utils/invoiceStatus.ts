import { InvoiceStatus } from "../types"

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

export function statusBadgeClass(status: InvoiceStatus): string {
  return statusColors[status] ?? "badge"
}

export function statusLabel(status: InvoiceStatus): string {
  return statusLabels[status] ?? status
}

/** Statuses the GET /invoices endpoint can filter on. */
export const FILTERABLE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.Pending,
  InvoiceStatus.Paid,
  InvoiceStatus.Expired,
  InvoiceStatus.Cancelled,
  InvoiceStatus.RefundRequested,
  InvoiceStatus.Released,
]
