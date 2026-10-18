import { useState } from "react"
import type { Invoice, InvoiceStatus } from "../types"
import { useT } from "../i18n"
import { StatusBadge } from "./StatusBadge"
import { CopyableText } from "./CopyableText"
import { RefundConfirmationModal } from "./RefundConfirmationModal"

interface RefundRequestProps {
  invoice: Invoice
  walletAddress: string | null
  /** Why the wallet cannot sign right now; disables the request when set. */
  walletNotReadyReason?: string | null
  onRequestRefund: () => Promise<{
    success: boolean
    transaction_hash?: string
    error?: string
  }>
}

// Configurable refund constraints
const REFUND_CONSTRAINTS = {
  MIN_REASON_LENGTH: 10,
  MAX_REASON_LENGTH: 500,
  FULL_REFUND_ONLY: true, // Contract only supports full refunds
}

export function RefundRequest({
  invoice,
  walletAddress,
  walletNotReadyReason = null,
  onRequestRefund,
}: RefundRequestProps) {
  const t = useT()
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    success: boolean
    hash?: string
    errorMsg?: string
  } | null>(null)
  const [reason, setReason] = useState("")
  const [reasonError, setReasonError] = useState<string | null>(null)

  const isPayer = walletAddress?.toLowerCase() === invoice.payer.toLowerCase()
  const canRequestRefund = isPayer && invoice.status === "Paid"

  const validateReason = (value: string): string | null => {
    if (!value.trim()) {
      return t("refundRequest.reasonError.required")
    }
    if (value.length < REFUND_CONSTRAINTS.MIN_REASON_LENGTH) {
      return t("refundRequest.reasonError.tooShort", {
        min: REFUND_CONSTRAINTS.MIN_REASON_LENGTH,
      })
    }
    if (value.length > REFUND_CONSTRAINTS.MAX_REASON_LENGTH) {
      return t("refundRequest.reasonError.tooLong", {
        max: REFUND_CONSTRAINTS.MAX_REASON_LENGTH,
      })
    }
    return null
  }

  const handleReasonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setReason(value)
    setReasonError(validateReason(value))
  }

  const handleRefundClick = () => {
    setResult(null)
    setReason("")
    setReasonError(null)
    setShowConfirm(true)
  }

  const handleConfirmRefund = async () => {
    const error = validateReason(reason)
    if (error) {
      setReasonError(error)
      return
    }

    setSubmitting(true)
    const res = await onRequestRefund()
    setSubmitting(false)
    setShowConfirm(false)
    setResult({
      success: res.success,
      hash: res.transaction_hash,
      errorMsg: res.error,
    })

    if (res.success) {
      setReason("")
      setReasonError(null)
    }
  }

  return (
    <div className="refund-section">
      {result && (
        <div
          className={`message message--${result.success ? "success" : "error"}`}
          role="status"
          aria-live="polite"
        >
          {result.success ? (
            <>
              {t("refundRequest.refundSuccess")}
              <br />
              {t("refundRequest.transactionHash")}{" "}
              <code className="tx-hash">
                <CopyableText
                  text={result.hash!}
                  label={t("common.copyTransactionHash")}
                />
              </code>
            </>
          ) : (
            <>{t("refundRequest.refundFailed", { error: result.errorMsg ?? "" })}</>
          )}
        </div>
      )}

      {canRequestRefund && !result?.success && (
        <>
          <div className="refund-form">
            <label htmlFor="refund-reason" className="refund-form__label">
              {t("refundRequest.reasonLabel")}{" "}
              <span className="required" aria-label={t("refundRequest.reasonRequired")}>
                *
              </span>
              <span className="refund-form__hint">
                {t("refundRequest.reasonHint", {
                  min: REFUND_CONSTRAINTS.MIN_REASON_LENGTH,
                })}
              </span>
            </label>
            <textarea
              id="refund-reason"
              className={`refund-form__textarea ${
                reasonError ? "refund-form__textarea--error" : ""
              }`}
              value={reason}
              onChange={handleReasonChange}
              placeholder={t("refundRequest.reasonPlaceholder")}
              maxLength={REFUND_CONSTRAINTS.MAX_REASON_LENGTH}
              disabled={submitting}
              aria-invalid={!!reasonError}
              aria-describedby={reasonError ? "reason-error" : "reason-hint"}
            />
            {reasonError && (
              <p id="reason-error" className="refund-form__error" role="alert">
                {reasonError}
              </p>
            )}
            <p id="reason-hint" className="refund-form__counter">
              {t("refundRequest.reasonCounter", {
                count: reason.length,
                max: REFUND_CONSTRAINTS.MAX_REASON_LENGTH,
              })}
            </p>
          </div>
          <button
            className="btn btn--danger"
            onClick={handleRefundClick}
            disabled={!reason.trim() || !!reasonError || submitting || !!walletNotReadyReason}
            aria-describedby={walletNotReadyReason ? "refund-wallet-reason" : undefined}
            aria-label={`Request refund for invoice #${invoice.id}`}
          >
            {t("refundRequest.requestRefund")}
          </button>
          {walletNotReadyReason && (
            <p id="refund-wallet-reason" className="wallet-required" data-testid="wallet-not-ready">
              {walletNotReadyReason}
            </p>
          )}
        </>
      )}

      {invoice.status === "RefundRequested" && (
        <div className="status-info">
          <StatusBadge status={invoice.status as InvoiceStatus} />
          <p>{t("refundRequest.refundRequested")}</p>
        </div>
      )}

      {!canRequestRefund &&
        invoice.status !== "RefundRequested" &&
        isPayer && (
          <p className="status-text">{t("refundRequest.canOnlyRefundPaid")}</p>
        )}

      {showConfirm && (
        <RefundConfirmationModal
          invoice={invoice}
          onConfirm={handleConfirmRefund}
          onCancel={() => setShowConfirm(false)}
          submitting={submitting}
        />
      )}
    </div>
  )
}
