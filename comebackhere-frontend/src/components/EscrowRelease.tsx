import { useCallback, useState } from "react"
import { useInvoice } from "../hooks/useInvoice"
import { useWallet } from "../hooks/useWallet"
import { usePolling } from "../hooks/usePolling"
import { fetchBalances } from "../utils/treasury"
import { StatusBadge } from "./StatusBadge"
import { InvoiceStatus } from "../types"

const TREASURY_BALANCE_POLL_MS = 10_000

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

  const isMerchantWallet = address && invoice?.merchant && address.toLowerCase() === invoice.merchant.toLowerCase()
  const canRelease = connected && invoice?.status === InvoiceStatus.Paid && isMerchantWallet

  // Polled (not one-shot) so a balance that was sufficient when the invoice
  // was first loaded doesn't go stale while the merchant reviews the release.
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
                  Treasury balance ({treasuryBalance} USDC) is below this invoice's amount
                  ({invoice.amount_usdc} USDC). Releasing now would likely fail.
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
                Escrow release is available on Paid invoices
                (current status: {invoice.status}).
              </p>
            )}

            {connected && invoice.status === InvoiceStatus.Paid && !isMerchantWallet && (
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
                  Only the merchant wallet can release the escrow. This invoice's merchant is {invoice.merchant}.
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
