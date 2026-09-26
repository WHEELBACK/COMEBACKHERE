import { useState, useEffect, useCallback, type KeyboardEvent } from "react"
import type { InvoiceStatus } from "../types"
import { StatusBadge } from "./StatusBadge"
import { InvoiceListSkeleton } from "./Skeleton"
import { listInvoices, ApiError, INVOICE_PAGE_SIZE, type InvoicePage } from "../utils/api"
import { FILTERABLE_STATUSES, statusBadgeClass, statusLabel } from "../utils/invoiceStatus"
import { INVOICE_TOKENS, fromSmallestUnit } from "../utils/invoiceForm"

interface InvoiceListProps {
  /** Connected wallet address; invoices are listed for this merchant. */
  merchantAddress: string | null
  /** Called with the invoice id when a row is activated. */
  onOpenInvoice: (invoiceId: string) => void
  /** Optional shortcut from the empty state to the create form. */
  onCreateInvoice?: () => void
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; result: InvoicePage }

function formatAmount(amount: number, token: string): string {
  const decimals = INVOICE_TOKENS[token as keyof typeof INVOICE_TOKENS] ?? 7
  return `${fromSmallestUnit(amount, decimals)} ${token}`
}

function formatDate(value: number | string): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString()
}

export function InvoiceList({ merchantAddress, onOpenInvoice, onCreateInvoice }: InvoiceListProps) {
  const [status, setStatus] = useState<InvoiceStatus | null>(null)
  const [page, setPage] = useState(1)
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<LoadState>({ kind: "loading" })

  useEffect(() => {
    if (!merchantAddress) return
    const controller = new AbortController()
    setState({ kind: "loading" })
    listInvoices({ merchant: merchantAddress, status, page, limit: INVOICE_PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setState({ kind: "loaded", result })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const message = err instanceof ApiError || err instanceof Error ? err.message : "Failed to load invoices"
        setState({ kind: "error", message })
      })
    return () => controller.abort()
  }, [merchantAddress, status, page, reloadKey])

  const handleFilter = useCallback((next: InvoiceStatus | null) => {
    setStatus(next)
    setPage(1)
  }, [])

  const retry = useCallback(() => setReloadKey((k) => k + 1), [])

  const handleRowKeyDown = (invoiceId: string) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onOpenInvoice(invoiceId)
    }
  }

  if (!merchantAddress) {
    return (
      <div className="invoice-list">
        <h2>My Invoices</h2>
        <div className="message message--warning" role="status">
          Connect your wallet to see the invoices you have created.
        </div>
      </div>
    )
  }

  const totalPages = state.kind === "loaded" ? Math.max(1, state.result.totalPages) : 1

  return (
    <div className="invoice-list">
      <h2>My Invoices</h2>

      <div className="status-filter" role="group" aria-label="Filter invoices by status">
        <button
          type="button"
          className={`status-filter__chip badge ${status === null ? "status-filter__chip--active" : ""}`}
          aria-pressed={status === null}
          onClick={() => handleFilter(null)}
        >
          All
        </button>
        {FILTERABLE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`status-filter__chip ${statusBadgeClass(s)} ${status === s ? "status-filter__chip--active" : ""}`}
            aria-pressed={status === s}
            onClick={() => handleFilter(s)}
          >
            {statusLabel(s)}
          </button>
        ))}
      </div>

      {state.kind === "loading" && <InvoiceListSkeleton rows={4} />}

      {state.kind === "error" && (
        <div className="message message--error invoice-list__error" role="alert">
          <span>Could not load invoices: {state.message}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {state.kind === "loaded" && state.result.data.length === 0 && (
        <div className="invoice-list__empty" data-testid="invoice-list-empty">
          {status ? (
            <>
              <p>No {statusLabel(status).toLowerCase()} invoices.</p>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => handleFilter(null)}>
                Show all invoices
              </button>
            </>
          ) : (
            <>
              <p>You have not created any invoices yet.</p>
              {onCreateInvoice && (
                <button type="button" className="btn btn--primary btn--sm" onClick={onCreateInvoice}>
                  Create your first invoice
                </button>
              )}
            </>
          )}
        </div>
      )}

      {state.kind === "loaded" && state.result.data.length > 0 && (
        <>
          <table className="invoice-table">
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col">Created</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {state.result.data.map((invoice) => (
                <tr
                  key={invoice.invoice_id}
                  className="invoice-table__row"
                  tabIndex={0}
                  aria-label={`Open invoice #${invoice.invoice_id}`}
                  onClick={() => onOpenInvoice(invoice.invoice_id)}
                  onKeyDown={handleRowKeyDown(invoice.invoice_id)}
                  data-testid="invoice-row"
                >
                  <td data-label="Invoice" className="invoice-table__id">#{invoice.invoice_id}</td>
                  <td data-label="Amount">{formatAmount(invoice.amount, invoice.token)}</td>
                  <td data-label="Status">
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td data-label="Due">{formatDate(invoice.due_date)}</td>
                  <td data-label="Created">{formatDate(invoice.created_at)}</td>
                  <td data-label="Reference">{invoice.reference || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <nav className="pagination" aria-label="Invoice pages">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </button>
            <span className="pagination__status" aria-live="polite">
              Page {state.result.page} of {totalPages} · {state.result.total} invoice{state.result.total === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={state.result.page >= totalPages}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </div>
  )
}
