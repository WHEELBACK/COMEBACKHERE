import type { InvoiceStatus } from "../types"
import { statusBadgeClass, statusLabel } from "../utils/invoiceStatus"

interface StatusBadgeProps {
  status: InvoiceStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = statusLabel(status)
  return (
    <span className={statusBadgeClass(status)} role="status" aria-label={`Invoice status: ${label}`}>{label}</span>
  )
}
