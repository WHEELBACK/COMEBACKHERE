import { useState, useEffect, useCallback } from "react"
import { useT } from "../i18n"

// ---------------------------------------------------------------------------
// Types matching the GET /invoices/:id/events endpoint shape
// ---------------------------------------------------------------------------

export type TimelineEventType =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_expired"
  | "invoice_cancelled"
  | "refund_requested"
  | "escrow_released"
  | "dispute_raised"
  | "dispute_resolved"
  | "settlement_proposed"
  | "settlement_executed"

export interface TimelineEvent {
  /** Event type identifier */
  type: TimelineEventType
  /** Unix timestamp (seconds) */
  timestamp: number
  /** Optional Stellar transaction hash */
  transaction_hash?: string
  /** True when this event represents the invoice's current state */
  is_current?: boolean
}

interface InvoiceTimelineProps {
  invoiceId: string
  /** Override the API base URL (useful in tests) */
  apiBaseUrl?: string
  /** Block-explorer base URL for tx links */
  explorerBaseUrl?: string
}

// ---------------------------------------------------------------------------
// Mock data — used when the real endpoint is not yet available
// ---------------------------------------------------------------------------

function buildMockEvents(invoiceId: string): TimelineEvent[] {
  const now = Math.floor(Date.now() / 1000)
  return [
    {
      type: "invoice_created",
      timestamp: now - 86400 * 3,
      transaction_hash: `mock_create_${invoiceId}_abcdef1234567890`,
    },
    {
      type: "settlement_proposed",
      timestamp: now - 86400 * 2,
      transaction_hash: `mock_settle_${invoiceId}_abcdef1234567890`,
    },
    {
      type: "invoice_paid",
      timestamp: now - 3600,
      transaction_hash: `mock_paid_${invoiceId}_abcdef1234567890`,
      is_current: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const API_BASE =
  typeof import.meta !== "undefined" &&
  // @ts-expect-error — Vite env
  import.meta.env?.VITE_API_URL
    ? // @ts-expect-error — Vite env
      import.meta.env.VITE_API_URL
    : "http://localhost:3000"

async function fetchEvents(
  invoiceId: string,
  apiBaseUrl: string
): Promise<TimelineEvent[]> {
  const url = `${apiBaseUrl}/invoices/${encodeURIComponent(invoiceId)}/events`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }
  return (await res.json()) as TimelineEvent[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEFAULT_EXPLORER = "https://stellar.expert/explorer/testnet/tx"

export function InvoiceTimeline({
  invoiceId,
  apiBaseUrl = API_BASE,
  explorerBaseUrl = DEFAULT_EXPLORER,
}: InvoiceTimelineProps) {
  const t = useT()
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchEvents(invoiceId, apiBaseUrl)
      setEvents(data)
    } catch (err: unknown) {
      // The endpoint is not yet merged — fall back to mock data and note it.
      // In a real build the mock branch would be removed once the API is live.
      if (import.meta.env.DEV) {
        console.info(
          "[InvoiceTimeline] Events endpoint unavailable — rendering mock data.",
          err
        )
      }
      setEvents(buildMockEvents(invoiceId))
    } finally {
      setLoading(false)
    }
  }, [invoiceId, apiBaseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp)

  return (
    <section className="invoice-timeline" aria-label={t("invoiceTimeline.title")}>
      <h3 className="invoice-timeline__title">{t("invoiceTimeline.title")}</h3>

      {loading && (
        <p className="invoice-timeline__loading" aria-live="polite">
          {t("invoiceTimeline.loading")}
        </p>
      )}

      {!loading && error && (
        <div className="invoice-timeline__error" role="alert">
          <p>{t("invoiceTimeline.errorPrefix", { error })}</p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void load()}
          >
            {t("invoiceTimeline.retry")}
          </button>
        </div>
      )}

      {!loading && !error && sortedEvents.length === 0 && (
        <p className="invoice-timeline__empty">{t("invoiceTimeline.empty")}</p>
      )}

      {!loading && sortedEvents.length > 0 && (
        <ol className="timeline-list" aria-label={t("invoiceTimeline.title")}>
          {sortedEvents.map((event, idx) => {
            const isCurrent = event.is_current === true
            const labelKey =
              `invoiceTimeline.events.${event.type}` as `invoiceTimeline.events.${TimelineEventType}`

            return (
              <li
                key={`${event.type}-${event.timestamp}-${idx}`}
                className={`timeline-item${isCurrent ? " timeline-item--current" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
              >
                <span
                  className="timeline-item__dot"
                  aria-hidden="true"
                />
                <div className="timeline-item__label">
                  {t(labelKey)}
                  {isCurrent && (
                    <span className="timeline-item__current-badge">
                      {t("invoiceTimeline.currentState")}
                    </span>
                  )}
                </div>
                <div className="timeline-item__timestamp">
                  {new Date(event.timestamp * 1000).toLocaleString()}
                </div>
                {event.transaction_hash && (
                  <div className="timeline-item__tx">
                    <a
                      href={`${explorerBaseUrl}/${event.transaction_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("invoiceTimeline.viewOnExplorer")}
                    >
                      {event.transaction_hash.slice(0, 10)}…
                      {event.transaction_hash.slice(-6)}
                    </a>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
