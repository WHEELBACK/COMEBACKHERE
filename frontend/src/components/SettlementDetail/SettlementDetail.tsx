import { useMemo } from 'react'
import { Settlement, SignerInfo } from '../../types'
import { useSettlementHistory, SettlementEvent } from '../../hooks/useSettlementHistory'
import './SettlementDetail.css'

interface SettlementDetailProps {
  settlement: Settlement
  threshold: number
  signers: SignerInfo[]
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

function ApprovalProgressRing({ current, required }: { current: number; required: number }) {
  const pct = Math.min(100, required > 0 ? (current / required) * 100 : 0)
  const radius = 54
  const stroke = 8
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (pct / 100) * circumference
  const isComplete = current >= required

  return (
    <div className="approval-ring">
      <svg className="approval-ring__svg" viewBox="0 0 128 128">
        <circle
          className="approval-ring__bg"
          cx="64"
          cy="64"
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          className="approval-ring__fill"
          cx="64"
          cy="64"
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            stroke: isComplete ? '#22c55e' : '#3b82f6',
            transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease',
          }}
        />
      </svg>
      <div className="approval-ring__label">
        <span className="approval-ring__value">{current}</span>
        <span className="approval-ring__separator">/</span>
        <span className="approval-ring__total">{required}</span>
      </div>
      <p className="approval-ring__status">
        {isComplete ? 'Threshold reached' : `${required - current} more needed`}
      </p>
    </div>
  )
}

function SignerApprovalList({ signers, approvals }: { signers: SignerInfo[]; approvals: string[] }) {
  return (
    <div className="signer-approval-list">
      <h4 className="signer-approval-list__title">Signer Approvals</h4>
      <ul className="signer-approval-list__items">
        {signers.filter(s => s.address).map(signer => {
          const approved = approvals.includes(signer.address)
          return (
            <li
              key={signer.address}
              className={`signer-approval-item ${approved ? 'signer-approval-item--approved' : 'signer-approval-item--pending'}`}
            >
              <span className="signer-approval-item__icon">
                {approved ? '✓' : '○'}
              </span>
              <span className="signer-approval-item__address" title={signer.address}>
                {shorten(signer.address)}
              </span>
              <span className="signer-approval-item__weight">
                weight: {signer.weight}
              </span>
              <span className={`signer-approval-item__badge ${approved ? 'signer-approval-item__badge--approved' : 'signer-approval-item__badge--pending'}`}>
                {approved ? 'Approved' : 'Pending'}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ApprovalProgressBar({ current, required }: { current: number; required: number }) {
  const pct = Math.min(100, required > 0 ? (current / required) * 100 : 0)
  const isComplete = current >= required

  return (
    <div className="approval-progress-bar">
      <div className="approval-progress-bar__track">
        <div
          className="approval-progress-bar__fill"
          style={{
            width: `${pct}%`,
            backgroundColor: isComplete ? '#22c55e' : '#3b82f6',
            transition: 'width 0.6s ease, background-color 0.3s ease',
          }}
        />
        {Array.from({ length: required }, (_, i) => (
          <div
            key={i}
            className="approval-progress-bar__marker"
            style={{ left: `${((i + 1) / required) * 100}%` }}
          />
        ))}
      </div>
      <div className="approval-progress-bar__labels">
        <span>0</span>
        <span className="approval-progress-bar__pct">{Math.round(pct)}%</span>
        <span>{required}</span>
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatEventTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusDotClass(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, '')
  const known = ['pending', 'executed', 'partiallyexecuted', 'onhold', 'cancelled', 'proposed', 'approved']
  return `status-timeline__dot status-timeline__dot--${known.includes(key) ? key : 'default'}`
}

// ── StatusTimeline ────────────────────────────────────────────────────────────

interface StatusTimelineProps {
  events: SettlementEvent[]
  loading: boolean
  error: string | null
}

function StatusTimeline({ events, loading, error }: StatusTimelineProps) {
  if (loading) {
    return (
      <div className="status-timeline">
        <h3 className="status-timeline__title">Status History</h3>
        <p className="status-timeline__loading" role="status" aria-live="polite">
          Loading history…
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="status-timeline">
        <h3 className="status-timeline__title">Status History</h3>
        <p className="status-timeline__error" role="alert">
          Failed to load history: {error}
        </p>
      </div>
    )
  }

  return (
    <div className="status-timeline">
      <h3 className="status-timeline__title">Status History</h3>
      {events.length === 0 ? (
        <p className="status-timeline__empty">No status history available.</p>
      ) : (
        <ol
          className="status-timeline__list"
          aria-label="Settlement status history"
        >
          {events.map((evt, idx) => (
            <li key={idx} className="status-timeline__item">
              <span
                className={statusDotClass(evt.status)}
                aria-hidden="true"
              />
              <div className="status-timeline__content">
                <div className="status-timeline__status-row">
                  <span className="status-timeline__status-label">{evt.status}</span>
                  <time
                    className="status-timeline__timestamp"
                    dateTime={new Date(evt.timestamp * 1000).toISOString()}
                  >
                    {formatEventTimestamp(evt.timestamp)}
                  </time>
                </div>
                {evt.actor && (
                  <div className="status-timeline__actor" title={evt.actor}>
                    by {shorten(evt.actor)}
                  </div>
                )}
                {evt.note && (
                  <div className="status-timeline__note">{evt.note}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ── SettlementDetail ──────────────────────────────────────────────────────────

export default function SettlementDetail({ settlement, threshold, signers }: SettlementDetailProps) {
  const totalWeight = useMemo(
    () => signers.reduce((sum, s) => sum + s.weight, 0),
    [signers],
  )

  const { events, loading: historyLoading, error: historyError } = useSettlementHistory(settlement.id)

  return (
    <div className="settlement-detail">
      <div className="settlement-detail__header">
        <h2>Settlement #{settlement.id}</h2>
        <span className={`settlement-detail__status settlement-detail__status--${settlement.status.toLowerCase()}`}>
          {settlement.status}
        </span>
      </div>

      <div className="settlement-detail__info">
        <div className="settlement-detail__row">
          <span className="settlement-detail__label">Merchant</span>
          <span className="settlement-detail__value" title={settlement.merchant_address}>
            {shorten(settlement.merchant_address)}
          </span>
        </div>
        <div className="settlement-detail__row">
          <span className="settlement-detail__label">Amount (USDC)</span>
          <span className="settlement-detail__value">{formatAmount(settlement.amount)}</span>
        </div>
        <div className="settlement-detail__row">
          <span className="settlement-detail__label">Total Signer Weight</span>
          <span className="settlement-detail__value">{totalWeight}</span>
        </div>
      </div>

      <div className="settlement-detail__progress-section">
        <h3>Approval Progress</h3>
        <div className="settlement-detail__progress-visuals">
          <ApprovalProgressRing current={settlement.approval_weight} required={threshold} />
          <div className="settlement-detail__progress-details">
            <ApprovalProgressBar current={settlement.approval_weight} required={threshold} />
            <SignerApprovalList signers={signers} approvals={settlement.approvals} />
          </div>
        </div>
      </div>

      {settlement.hold_reason && (
        <div className="settlement-detail__hold-reason">
          <strong>Hold Reason:</strong> {settlement.hold_reason}
        </div>
      )}

      <StatusTimeline
        events={events}
        loading={historyLoading}
        error={historyError}
      />
    </div>
  )
}
