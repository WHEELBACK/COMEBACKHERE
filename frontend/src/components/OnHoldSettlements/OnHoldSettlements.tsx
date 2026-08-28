import { useState, useEffect, useCallback } from 'react'
import { Settlement } from '../../types'
import { EmptyState, EmptyStateIcon } from '../EmptyState/EmptyState'

const API_BASE = '/api'

type HoldReason = 'ComplianceReview' | 'FraudCheck' | 'KycPending' | 'AdminHold'

const holdReasonStyles: Record<HoldReason, React.CSSProperties> = {
  ComplianceReview: { background: '#e0e7ff', color: '#3730a3', border: '1px solid #6366f1' },
  FraudCheck:       { background: '#fee2e2', color: '#b91c1c', border: '1px solid #ef4444' },
  KycPending:       { background: '#fef9c3', color: '#854d0e', border: '1px solid #eab308' },
  AdminHold:        { background: '#f3f4f6', color: '#374151', border: '1px solid #9ca3af' },
}

function HoldReasonBadge({ reason }: { reason: string }) {
  const style = holdReasonStyles[reason as HoldReason] ?? holdReasonStyles.AdminHold
  return (
    <span
      style={{
        ...style,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
      aria-label={`Hold reason: ${reason}`}
    >
      {reason}
    </span>
  )
}

function shorten(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatAmount(raw: string): string {
  const n = Number(raw)
  if (isNaN(n)) return raw
  return (n / 10_000_000).toFixed(2)
}

type AdminAction = 'release' | 'escalate'

async function performAdminAction(settlementId: number, action: AdminAction): Promise<Settlement> {
  const endpoint = action === 'release'
    ? `${API_BASE}/treasury/release-hold`
    : `${API_BASE}/treasury/escalate-hold`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settlement_id: settlementId }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

interface BulkConfirmModalProps {
  count: number
  onConfirm: () => void
  onCancel: () => void
}

function BulkConfirmModal({ count, onConfirm, onCancel }: BulkConfirmModalProps) {
  return (
    <div
      style={modalStyles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
    >
      <div style={modalStyles.panel}>
        <h3 id="bulk-confirm-title" style={modalStyles.title}>
          Confirm Bulk Release
        </h3>
        <p style={modalStyles.message}>
          You are about to release <strong>{count}</strong> on-hold settlement
          {count === 1 ? '' : 's'}. Each will be submitted as a separate
          transaction. This action cannot be undone. Continue?
        </p>
        <div style={modalStyles.actions}>
          <button
            type="button"
            style={modalStyles.cancelBtn}
            onClick={onCancel}
            aria-label="Cancel bulk release"
          >
            Cancel
          </button>
          <button
            type="button"
            style={modalStyles.confirmBtn}
            onClick={onConfirm}
            aria-label="Confirm bulk release"
          >
            Release {count} settlement{count === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

const modalStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1rem',
  },
  panel: {
    background: 'var(--color-card-bg, #fff)',
    borderRadius: 8,
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    padding: '1.5rem',
    maxWidth: 440,
    width: '100%',
  },
  title: {
    fontSize: '1.1rem',
    fontWeight: 600,
    marginBottom: '0.75rem',
  },
  message: {
    color: 'var(--color-text-muted)',
    lineHeight: 1.6,
    marginBottom: '1.25rem',
    fontSize: '0.9rem',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
  },
  cancelBtn: {
    padding: '7px 16px',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    background: 'var(--color-card-bg)',
    color: 'var(--color-text)',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
  confirmBtn: {
    padding: '7px 16px',
    border: 'none',
    borderRadius: 6,
    background: 'var(--color-success, #16a34a)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
}

interface OnHoldSettlementsProps {
  /** Optional callback invoked when the user clicks the empty-state CTA */
  onNavigateToSettlements?: () => void
}

export default function OnHoldSettlements({ onNavigateToSettlements }: OnHoldSettlementsProps = {}) {
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [acting, setActing] = useState<Record<number, boolean>>({})
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const pageSize = 20

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [bulkReleasing, setBulkReleasing] = useState(false)

  const fetchOnHold = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/treasury/on-hold-settlements?page=${page}&limit=${pageSize}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Settlement[] = await res.json()
      setSettlements(data)
      // Clear selection when the list reloads (page change or refresh)
      setSelectedIds(new Set())
      const totalCount = res.headers.get('X-Total-Count')
      if (totalCount) {
        setTotalPages(Math.ceil(Number(totalCount) / pageSize))
      }
    } catch (e: any) {
      setError(e.message || 'Failed to fetch on-hold settlements')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    fetchOnHold()
    const interval = setInterval(fetchOnHold, 15_000)
    return () => clearInterval(interval)
  }, [fetchOnHold])

  const handleAction = async (settlementId: number, action: AdminAction) => {
    setActing(prev => ({ ...prev, [settlementId]: true }))
    setActionError(null)
    setActionSuccess(null)
    try {
      const updated = await performAdminAction(settlementId, action)
      setSettlements(prev => prev.map(s => s.id === updated.id ? updated : s).filter(s => s.status === 'OnHold'))
      setSelectedIds(prev => { const next = new Set(prev); next.delete(settlementId); return next })
      setActionSuccess(`Settlement #${settlementId} ${action === 'release' ? 'released' : 'escalated'}.`)
    } catch (e: any) {
      setActionError(`Failed to ${action} settlement #${settlementId}: ${e.message}`)
    } finally {
      setActing(prev => ({ ...prev, [settlementId]: false }))
    }
  }

  // ── Bulk selection helpers ─────────────────────────────────────────────────

  const allOnPageSelected =
    settlements.length > 0 && settlements.every(s => selectedIds.has(s.id))

  const someOnPageSelected =
    settlements.some(s => selectedIds.has(s.id)) && !allOnPageSelected

  const handleSelectAll = () => {
    if (allOnPageSelected) {
      // Deselect all on this page
      setSelectedIds(prev => {
        const next = new Set(prev)
        settlements.forEach(s => next.delete(s.id))
        return next
      })
    } else {
      // Select all on this page
      setSelectedIds(prev => {
        const next = new Set(prev)
        settlements.forEach(s => next.add(s.id))
        return next
      })
    }
  }

  const handleToggleRow = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // ── Bulk release ──────────────────────────────────────────────────────────

  const handleBulkRelease = async () => {
    setBulkReleasing(true)
    setShowBulkConfirm(false)
    setActionError(null)
    setActionSuccess(null)

    const ids = [...selectedIds]
    const errors: string[] = []
    let released = 0

    for (const id of ids) {
      setActing(prev => ({ ...prev, [id]: true }))
      try {
        const updated = await performAdminAction(id, 'release')
        setSettlements(prev =>
          prev.map(s => s.id === updated.id ? updated : s).filter(s => s.status === 'OnHold'),
        )
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
        released++
      } catch (e: any) {
        errors.push(`#${id}: ${e.message}`)
      } finally {
        setActing(prev => ({ ...prev, [id]: false }))
      }
    }

    if (errors.length > 0) {
      setActionError(`Bulk release completed with ${errors.length} error(s): ${errors.join('; ')}`)
    }
    if (released > 0) {
      setActionSuccess(`${released} settlement${released === 1 ? '' : 's'} released.`)
    }

    setBulkReleasing(false)
  }

  // ─────────────────────────────────────────────────────────────────────────

  if (loading && settlements.length === 0) {
    return <div style={styles.container}><p>Loading on-hold settlements...</p></div>
  }

  if (error && settlements.length === 0) {
    return <div style={styles.container}><p style={{ color: 'var(--color-danger)' }}>Error: {error}</p></div>
  }

  const selectedCount = [...selectedIds].filter(id => settlements.some(s => s.id === id)).length
  const isActing = bulkReleasing || Object.values(acting).some(Boolean)

  return (
    <div style={styles.container} role="region" aria-label="On-hold settlements">
      <h1 style={styles.title}>On-Hold Settlements</h1>

      {actionError && <p style={{ color: 'var(--color-danger)' }} role="alert">{actionError}</p>}
      {actionSuccess && <p style={{ color: 'var(--color-success)' }} role="status" aria-live="polite">{actionSuccess}</p>}

      {settlements.length === 0 ? (
        <EmptyState
          icon={<EmptyStateIcon />}
          title="No On-Hold Settlements"
          description="There are currently no settlements on hold. All settlements are processing normally."
          action={onNavigateToSettlements ? {
            label: 'Propose a Settlement',
            onClick: onNavigateToSettlements,
          } : undefined}
        />
      ) : (
        <>
          {/* ── Bulk action toolbar ────────────────────────────────── */}
          {selectedCount > 0 && (
            <div style={styles.bulkToolbar} role="toolbar" aria-label="Bulk actions">
              <span style={styles.bulkCount} aria-live="polite">
                {selectedCount} settlement{selectedCount === 1 ? '' : 's'} selected
              </span>
              <button
                style={styles.bulkReleaseBtn}
                disabled={isActing}
                onClick={() => setShowBulkConfirm(true)}
                aria-label={`Bulk release ${selectedCount} selected settlement${selectedCount === 1 ? '' : 's'}`}
              >
                {bulkReleasing ? 'Releasing…' : `Release Hold (${selectedCount})`}
              </button>
              <button
                style={styles.bulkClearBtn}
                disabled={isActing}
                onClick={() => setSelectedIds(new Set())}
                aria-label="Clear selection"
              >
                Clear selection
              </button>
            </div>
          )}

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    ref={el => { if (el) el.indeterminate = someOnPageSelected }}
                    onChange={handleSelectAll}
                    aria-label="Select all settlements on this page"
                    disabled={isActing}
                  />
                </th>
                <th style={styles.th}>ID</th>
                <th style={styles.th}>Merchant</th>
                <th style={styles.th}>Amount (USDC)</th>
                <th style={styles.th}>Hold Reason</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map(s => (
                <tr key={s.id} style={selectedIds.has(s.id) ? styles.rowSelected : undefined}>
                  <td style={styles.td}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => handleToggleRow(s.id)}
                      aria-label={`Select settlement #${s.id}`}
                      disabled={!!acting[s.id] || bulkReleasing}
                    />
                  </td>
                  <td style={styles.td}>{s.id}</td>
                  <td style={styles.td}>{shorten(s.merchant_address)}</td>
                  <td style={styles.td}>{formatAmount(s.amount)}</td>
                  <td style={styles.td}>
                    {s.hold_reason ? (
                      <HoldReasonBadge reason={s.hold_reason} />
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={styles.releaseBtn}
                        disabled={!!acting[s.id] || bulkReleasing}
                        onClick={() => handleAction(s.id, 'release')}
                        aria-label={`Release hold on settlement #${s.id}`}
                      >
                        {acting[s.id] ? '...' : 'Release'}
                      </button>
                      <button
                        style={styles.escalateBtn}
                        disabled={!!acting[s.id] || bulkReleasing}
                        onClick={() => handleAction(s.id, 'escalate')}
                        aria-label={`Escalate settlement #${s.id}`}
                      >
                        {acting[s.id] ? '...' : 'Escalate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style={styles.pagination}>
              <button
                style={styles.paginationBtn}
                disabled={page === 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                aria-label="Previous page"
              >
                Previous
              </button>
              <span style={styles.paginationInfo}>
                Page {page} of {totalPages}
              </span>
              <button
                style={styles.paginationBtn}
                disabled={page === totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {showBulkConfirm && (
        <BulkConfirmModal
          count={selectedCount}
          onConfirm={() => void handleBulkRelease()}
          onCancel={() => setShowBulkConfirm(false)}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 960,
    margin: '0 auto',
    padding: '2rem 1rem',
    fontFamily: 'system-ui, sans-serif',
    color: 'var(--color-text)',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 600,
    marginBottom: '1.5rem',
  },
  bulkToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '0.75rem',
    padding: '0.5rem 0.75rem',
    background: 'var(--color-info-soft-bg, #dbeafe)',
    borderRadius: 6,
    border: '1px solid var(--color-info-soft-border, #93c5fd)',
  },
  bulkCount: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: 'var(--color-text)',
    flex: 1,
  },
  bulkReleaseBtn: {
    padding: '5px 14px',
    fontSize: '0.8rem',
    fontWeight: 600,
    border: 'none',
    borderRadius: 4,
    background: 'var(--color-success, #16a34a)',
    color: '#fff',
    cursor: 'pointer',
  },
  bulkClearBtn: {
    padding: '5px 14px',
    fontSize: '0.8rem',
    fontWeight: 600,
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--color-text)',
    cursor: 'pointer',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    background: 'var(--color-card-bg)',
    boxShadow: 'var(--shadow)',
  },
  th: {
    textAlign: 'left',
    padding: '0.5rem',
    borderBottom: '2px solid var(--color-border)',
    fontWeight: 600,
    fontSize: '0.875rem',
    color: 'var(--color-text-muted)',
  },
  td: {
    padding: '0.5rem',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '0.875rem',
  },
  rowSelected: {
    background: 'var(--color-info-soft-bg, #eff6ff)',
  },
  releaseBtn: {
    padding: '4px 10px',
    fontSize: '0.75rem',
    border: '1px solid var(--color-success)',
    borderRadius: 4,
    background: 'var(--color-success)',
    color: '#fff',
    cursor: 'pointer',
  },
  escalateBtn: {
    padding: '4px 10px',
    fontSize: '0.75rem',
    border: '1px solid var(--color-warning)',
    borderRadius: 4,
    background: 'var(--color-warning)',
    color: '#fff',
    cursor: 'pointer',
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    marginTop: '20px',
    padding: '16px',
  },
  paginationBtn: {
    padding: '8px 16px',
    fontSize: '0.875rem',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    background: 'var(--color-card-bg)',
    color: 'var(--color-text)',
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s',
  },
  paginationInfo: {
    fontSize: '0.875rem',
    color: 'var(--color-text-muted)',
  },
}
