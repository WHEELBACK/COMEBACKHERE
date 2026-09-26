import { useCallback, useEffect, useRef, useState } from "react"
import { useInvoice } from "../hooks/useInvoice"
import { useWallet } from "../hooks/useWallet"
import { usePolling } from "../hooks/usePolling"
import { fetchBalances } from "../utils/treasury"
import { StatusBadge } from "./StatusBadge"
import { InvoiceStatus } from "../types"
import { config } from "../config"

const TREASURY_BALANCE_POLL_MS = 10_000

/**
 * Stellar ledger closes every ~5 s. We apply a small margin (one extra ledger)
 * so the release button only becomes active once we are reasonably confident
 * the on-chain grace window has elapsed, even with minor clock skew.
 */
const LEDGER_CLOSE_S = 5
const CLOCK_SKEW_MARGIN_S = LEDGER_CLOSE_S

/** Default grace window used when the backend does not return one. */
const DEFAULT_GRACE_WINDOW_S = 86_400 // 24 h

interface GraceWindowConfig {
  grace_window_seconds: number
}

/** Format seconds into HH:MM:SS (or MM:SS when < 1 h). */
function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export function EscrowRelease() {
  const { invoice, loading, error, loadInvoice, release } = useInvoice()
  const { address, connected, connecting, connect } = useWallet()
  const [invoiceId, setInvoiceId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    success: boolean
    hash?: string
    errorMsg?: string
  } | null>(null)
  const [treasuryBalance, setTreasuryBalance] = useState<string | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  // Grace-window countdown state
  const [graceWindowSeconds, setGraceWindowSeconds] = useState<number>(DEFAULT_GRACE_WINDOW_S)
  const [secondsUntilRelease, setSecondsUntilRelease] = useState<number | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---------------------------------------------------------------------------
  // Fetch the configured grace window from the backend once per invoice load.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    async function fetchGraceWindow() {
      try {
        const res = await fetch(`${config.apiUrl}/invoice-settings`)
        if (!res.ok) return
        const data: GraceWindowConfig = await res.json()
        if (!cancelled && typeof data.grace_window_seconds === "number") {
          setGraceWindowSeconds(data.grace_window_seconds)
        }
      } catch {
        // Silently fall back to the default; the countdown still works.
      }
    }
    fetchGraceWindow()
    return () => { cancelled = true }
  }, [])

  // ---------------------------------------------------------------------------
  // Start / update the countdown whenever the invoice or grace window changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }

    if (!invoice || invoice.status !== InvoiceStatus.Paid || invoice.paid_at === null) {
      setSecondsUntilRelease(null)
      return
    }

    const releaseAt = invoice.paid_at + graceWindowSeconds + CLOCK_SKEW_MARGIN_S

    const tick = () => {
      const remaining = releaseAt - Date.now() / 1000
      setSecondsUntilRelease(remaining)
    }

    tick() // immediate first render
    countdownRef.current = setInterval(tick, 1000)

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [invoice, graceWindowSeconds])

  // ---------------------------------------------------------------------------
  // Invoice / wallet helpers
  // ---------------------------------------------------------------------------
  const handleLoadInvoice = async () => {
    setResult(null)
    await loadInvoice(Number(invoiceId))
  }

  const handleRelease = async () => {
    if (!address) return
    setSubmitting(true)
    setResult(null)
    const res = await release(address)
    setSubmitting(false)
    setResult({
      success: res.success,
      hash: res.transaction_hash,
      errorMsg: res.error,
    })
  }

  const isMerchantWallet =
    address &&
    invoice?.merchant &&
    address.toLowerCase() === invoice.merchant.toLowerCase()

  /** True only when the grace window has fully elapsed (plus skew margin). */
  const graceWindowElapsed = secondsUntilRelease !== null && secondsUntilRelease <= 0

  const canRelease =
    connected &&
    invoice?.status === InvoiceStatus.Paid &&
    isMerchantWallet &&
    graceWindowElapsed

  // ---------------------------------------------------------------------------
  // Treasury balance polling
  // ---------------------------------------------------------------------------
  const loadTreasuryBalance = useCallback(async () => {
    if (!invoice || invoice.status !== InvoiceStatus.Paid) return
    try {
      const balances = await fetchBalances(address ?? invoice.merchant)
      setTreasuryBalance(balances[0]?.balance ?? "0")
      setBalanceError(null)
    } catch (err) {
      setBalanceError(
        err instanceof Error ? err.message : "Failed to fetch treasury balance"
      )
    }
  }, [address, invoice])

  usePolling(loadTreasuryBalance, {
    interval: TREASURY_BALANCE_POLL_MS,
    enabled: invoice?.status === InvoiceStatus.Paid,
  })

  const insufficientTreasuryFunds =
    invoice != null &&
    treasuryBalance !== null &&
    Number(treasuryBalance) < Number(invoice.amount_usdc)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="escrow-release">
      <h1>Escrow Release</h1>

      <div className="invoice-lookup">
        <input
          type="number"
          placeholder="Enter Invoice ID"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
        />
        <button
          className="btn btn--secondary"
          onClick={handleLoadInvoice}
          disabled={!invoiceId || loading}
        >
          {loading ? "Loading..." : "Load Invoice"}
        </button>
      </div>

      {loading && <p className="status-text">Loading invoice...</p>}

      {error && <div className="message message--error">{error}</div>}

      {result && (
        <div
          className={`message message--${result.success ? "success" : "error"}`}
        >
          {result.success ? (
            <>
              Escrow released successfully!
              <br />
              Transaction hash:{" "}
              <code className="tx-hash">{result.hash}</code>
            </>
          ) : (
            <>Release failed: {result.errorMsg}</>
          )}
        </div>
      )}

      {invoice && (
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h2>Invoice #{invoice.id}</h2>
            <StatusBadge status={invoice.status} />
          </div>

          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Merchant</span>
              <span className="detail-value detail-value--address">
                {invoice.merchant}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Amount (USDC)</span>
              <span className="detail-value">{invoice.amount_usdc}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <StatusBadge status={invoice.status} />
            </div>

            {/* Grace-window countdown — only shown for Paid invoices */}
            {invoice.status === InvoiceStatus.Paid && secondsUntilRelease !== null && (
              <div className="detail-row">
                <span className="detail-label">Release Window</span>
                <span className="detail-value" aria-live="polite" aria-label="Time until escrow release">
                  {graceWindowElapsed ? (
                    <span style={{ color: "var(--color-success, green)", fontWeight: 600 }}>
                      Ready to release
                    </span>
                  ) : (
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      Available in{" "}
                      <strong data-testid="countdown-timer">
                        {formatCountdown(secondsUntilRelease)}
                      </strong>
                    </span>
                  )}
                </span>
              </div>
            )}

            {invoice.status === InvoiceStatus.Paid && (
              <div className="detail-row">
                <span className="detail-label">Treasury USDC Balance</span>
                <span className="detail-value">
                  {balanceError
                    ? "Unavailable"
                    : treasuryBalance === null
                    ? "Loading..."
                    : treasuryBalance}
                </span>
              </div>
            )}
          </div>

          <div className="invoice-card__actions">
            {!connected && (
              <button
                className="btn btn--primary"
                onClick={connect}
                disabled={connecting}
              >
                {connecting ? "Connecting..." : "Connect Wallet"}
              </button>
            )}

            {/* Grace window not yet elapsed */}
            {connected &&
              invoice.status === InvoiceStatus.Paid &&
              isMerchantWallet &&
              !graceWindowElapsed && (
                <div
                  style={{
                    padding: "12px",
                    background: "var(--color-warning-bg)",
                    border: "1px solid var(--color-warning-border)",
                    borderRadius: "var(--radius)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                  role="alert"
                  aria-label="Grace window countdown"
                >
                  <span style={{ flex: 1 }}>
                    The grace window has not elapsed yet. Release will be available
                    in{" "}
                    <strong data-testid="countdown-alert-timer">
                      {secondsUntilRelease !== null
                        ? formatCountdown(secondsUntilRelease)
                        : "…"}
                    </strong>
                    . The button will enable automatically when the time has passed.
                  </span>
                  <button
                    className="btn btn--primary"
                    disabled
                    title="Grace window has not elapsed yet"
                  >
                    Release Escrow
                  </button>
                </div>
              )}

            {/* Insufficient treasury funds */}
            {connected && canRelease && insufficientTreasuryFunds && (
              <div
                style={{
                  padding: "12px",
                  background: "var(--color-warning-bg)",
                  border: "1px solid var(--color-warning-border)",
                  borderRadius: "var(--radius)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
                role="alert"
              >
                <span style={{ flex: 1 }}>
                  Treasury balance ({treasuryBalance} USDC) is below this
                  invoice's amount ({invoice.amount_usdc} USDC). Releasing now
                  would likely fail.
                </span>
                <button
                  className="btn btn--primary"
                  disabled
                  title="Treasury does not currently hold enough USDC to settle this release"
                >
                  Release Escrow
                </button>
              </div>
            )}

            {/* Ready to release */}
            {connected && canRelease && !insufficientTreasuryFunds && (
              <button
                className="btn btn--primary"
                onClick={handleRelease}
                disabled={submitting}
              >
                {submitting ? "Releasing..." : "Release Escrow"}
              </button>
            )}

            {connected && invoice.status !== InvoiceStatus.Paid && (
              <p className="status-text">
                Escrow release is available on Paid invoices (current status:{" "}
                {invoice.status}).
              </p>
            )}

            {connected &&
              invoice.status === InvoiceStatus.Paid &&
              !isMerchantWallet && (
                <div
                  style={{
                    padding: "12px",
                    background: "var(--color-warning-bg)",
                    border: "1px solid var(--color-warning-border)",
                    borderRadius: "var(--radius)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                  role="alert"
                >
                  <span style={{ flex: 1 }}>
                    Only the merchant wallet can release the escrow. This
                    invoice's merchant is {invoice.merchant}.
                  </span>
                  <button
                    className="btn btn--primary"
                    disabled
                    title="You must connect with the merchant's wallet to release this escrow"
                  >
                    Release Escrow
                  </button>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  )
}
