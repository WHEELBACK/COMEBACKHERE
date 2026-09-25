import { useState, useEffect } from "react"
import { useInvoice } from "../hooks/useInvoice"
import { useWallet } from "../hooks/useWallet"
import { useT } from "../i18n"
import { StatusBadge } from "./StatusBadge"
import { CopyableText } from "./CopyableText"
import { PayConfirmationModal } from "./PayConfirmationModal"
import { CancelConfirmationModal } from "./CancelConfirmationModal"
import { TransactionHistory } from "./TransactionHistory"
import { InvoiceQRCode } from "./InvoiceQRCode"
import { InvoiceTimeline } from "./InvoiceTimeline"
import { PaymentReceipt } from "./PaymentReceipt"

export function InvoicePayment() {
  const { invoice, loading, error, loadInvoice, pay, cancel } = useInvoice()
  const { address, connected, connecting, connect } = useWallet()
  const t = useT()
  const [invoiceId, setInvoiceId] = useState("")
  const [showConfirm, setShowConfirm] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [timeLeft, setTimeLeft] = useState<{
    days: number
    hours: number
    minutes: number
    seconds: number
  } | null>(null)
  const [result, setResult] = useState<{
    success: boolean
    hash?: string
    errorMsg?: string
    paidAt?: number
  } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get("invoiceId")
    if (id) {
      setInvoiceId(id)
      loadInvoice(Number(id))
    }
  }, [loadInvoice])

  useEffect(() => {
    if (!invoice?.expires_at) {
      setTimeLeft(null)
      return
    }

    const updateTimer = () => {
      const diff = invoice.expires_at * 1000 - Date.now()
      if (diff <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 })
        if (invoice.status === "Pending") {
          void loadInvoice(Number(invoice.id))
        }
        return
      }

      const totalSeconds = Math.floor(diff / 1000)
      setTimeLeft({
        days: Math.floor(totalSeconds / 86400),
        hours: Math.floor((totalSeconds % 86400) / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
      })
    }

    updateTimer()
    const timer = window.setInterval(updateTimer, 1000)
    return () => window.clearInterval(timer)
  }, [invoice?.expires_at, invoice?.id, invoice?.status, loadInvoice])

  const handleLoadInvoice = async () => {
    setResult(null)
    await loadInvoice(Number(invoiceId))
  }

  const handlePayClick = () => {
    setResult(null)
    setShowConfirm(true)
  }

  const handleConfirmPayment = async () => {
    if (!address) return
    setSubmitting(true)
    const res = await pay(address)
    setSubmitting(false)
    setShowConfirm(false)
    setResult({
      success: res.success,
      hash: res.transaction_hash,
      errorMsg: res.error,
      paidAt: res.success ? Math.floor(Date.now() / 1000) : undefined,
    })
  }

  const handleCancelClick = () => {
    setResult(null)
    setShowCancelConfirm(true)
  }

  const handleConfirmCancel = async () => {
    if (!address) return
    setSubmitting(true)
    const res = await cancel(address)
    setSubmitting(false)
    setShowCancelConfirm(false)
    setResult({
      success: res.success,
      hash: res.transaction_hash,
      errorMsg: res.error,
    })
  }

  const canPay = connected && invoice?.status === "Pending"

  const isMerchant =
    connected &&
    address != null &&
    invoice?.merchant != null &&
    address.toLowerCase() === invoice.merchant.toLowerCase()

  const canCancel = isMerchant && invoice?.status === "Pending"

  const hasOpenDispute = invoice?.status === "RefundRequested"

  // Show receipt when payment succeeded and we have a tx hash
  const showReceipt =
    result?.success === true &&
    result.hash != null &&
    invoice != null &&
    invoice.status !== "Cancelled"

  return (
    <div className="payment-flow">
      <h1>{t("invoicePayment.title")}</h1>

      <div
        className="invoice-lookup"
        role="search"
        aria-label={t("invoicePayment.lookupAriaLabel")}
      >
        <label htmlFor="payment-invoice-id" className="sr-only">
          {t("invoicePayment.invoiceIdLabel")}
        </label>
        <input
          id="payment-invoice-id"
          type="number"
          placeholder={t("invoicePayment.invoiceIdPlaceholder")}
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          aria-label={t("invoicePayment.invoiceIdAriaLabel")}
        />
        <button
          className="btn btn--primary"
          onClick={handleLoadInvoice}
          disabled={!invoiceId || loading}
          aria-label={
            loading
              ? t("invoicePayment.loadingAriaLabel")
              : t("invoicePayment.loadInvoiceAriaLabel")
          }
        >
          {loading ? t("invoicePayment.loading") : t("invoicePayment.loadInvoice")}
        </button>
      </div>

      {loading && (
        <p className="status-text" aria-live="polite">
          {t("invoicePayment.loadingInvoice")}
        </p>
      )}

      {error && (
        <div className="message message--error" role="alert">
          {error}
        </div>
      )}

      {result && !showReceipt && (
        <div
          className={`message message--${result.success ? "success" : "error"}`}
          role="status"
          aria-live="polite"
        >
          {result.success ? (
            <>
              {invoice?.status === "Cancelled"
                ? t("invoicePayment.cancelSuccess")
                : t("invoicePayment.paymentSuccess")}
              <br />
              {t("invoicePayment.transactionHash")}{" "}
              <code className="tx-hash">
                <CopyableText
                  text={result.hash!}
                  label={t("common.copyTransactionHash")}
                />
              </code>
            </>
          ) : (
            <>{t("invoicePayment.operationFailed", { error: result.errorMsg ?? "" })}</>
          )}
        </div>
      )}

      {/* Payment Receipt — shown after a successful pay, hides the status message */}
      {showReceipt && invoice && result?.hash && (
        <PaymentReceipt
          invoice={invoice}
          transactionHash={result.hash}
          paidAt={result.paidAt ?? Math.floor(Date.now() / 1000)}
        />
      )}

      {invoice && (
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h2>
              Invoice #
              <CopyableText
                text={String(invoice.id)}
                label={t("invoiceCard.copyInvoiceId")}
              />
            </h2>
            <StatusBadge status={invoice.status} />
          </div>

          {hasOpenDispute && (
            <div className="message message--warning" role="status" aria-live="polite">
              <strong>{t("invoicePayment.disputeInProgress")}</strong>{" "}
              {t("invoicePayment.disputeWarning")}
            </div>
          )}

          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.amountUsdc")}</span>
              <span className="detail-value">{invoice.amount_usdc}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.countdown")}</span>
              <span className="detail-value">
                {invoice.status === "Expired" ||
                (timeLeft &&
                  timeLeft.days === 0 &&
                  timeLeft.hours === 0 &&
                  timeLeft.minutes === 0 &&
                  timeLeft.seconds === 0) ? (
                  <span className="badge badge--expired">{t("invoiceCard.expired")}</span>
                ) : timeLeft ? (
                  `${timeLeft.days}d ${timeLeft.hours}h ${timeLeft.minutes}m ${timeLeft.seconds}s`
                ) : (
                  "--"
                )}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.grossAmountUsdc")}</span>
              <span className="detail-value">{invoice.gross_usdc}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.merchant")}</span>
              <span className="detail-value detail-value--address">
                <CopyableText
                  text={invoice.merchant}
                  label={t("invoiceCard.copyMerchantAddress")}
                />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.expiry")}</span>
              <span className="detail-value">
                {new Date(invoice.expires_at * 1000).toLocaleString()}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("invoiceCard.status")}</span>
              <StatusBadge status={invoice.status} />
            </div>
          </div>

          <div
            className="invoice-card__actions"
            role="group"
            aria-label={t("invoicePayment.invoiceActionsAriaLabel")}
          >
            {!connected && (
              <button
                className="btn btn--primary"
                onClick={connect}
                disabled={connecting}
                aria-label={t("invoicePayment.connectToPayInvoice")}
              >
                {connecting ? t("wallet.connecting") : t("wallet.connect")}
              </button>
            )}

            {connected && canPay && (
              <button
                className="btn btn--primary"
                onClick={handlePayClick}
                aria-label={t("invoicePayment.payInvoiceAriaLabel", { id: invoice.id })}
              >
                {t("invoicePayment.payInvoice")}
              </button>
            )}

            {canCancel && (
              <button className="btn btn--danger" onClick={handleCancelClick}>
                {t("invoicePayment.cancelInvoice")}
              </button>
            )}

            {connected && invoice.status !== "Pending" && !hasOpenDispute && (
              <p className="status-text">
                {t("invoicePayment.notAvailableForPayment", { status: invoice.status })}
              </p>
            )}
          </div>
        </div>
      )}

      {invoice && <InvoiceQRCode invoiceId={invoice.id} />}

      {invoice && <InvoiceTimeline invoiceId={invoice.id} />}

      {invoice && <TransactionHistory invoice={invoice} />}

      {showConfirm && invoice && (
        <PayConfirmationModal
          invoice={invoice}
          onConfirm={handleConfirmPayment}
          onCancel={() => setShowConfirm(false)}
          submitting={submitting}
        />
      )}

      {showCancelConfirm && invoice && (
        <CancelConfirmationModal
          invoice={invoice}
          onConfirm={handleConfirmCancel}
          onCancel={() => setShowCancelConfirm(false)}
          submitting={submitting}
        />
      )}
    </div>
  )
}
