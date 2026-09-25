import { useState } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import type { Invoice } from "../types"
import { StatusBadge } from "./StatusBadge"
import { CopyableText } from "./CopyableText"
import { formatAmount, USDC_DECIMALS } from "../utils/format"

interface RefundConfirmationModalProps {
  invoice: Invoice
  onConfirm: () => Promise<void>
  onCancel: () => void
  submitting: boolean
}

export function RefundConfirmationModal({
  invoice,
  onConfirm,
  onCancel,
  submitting,
}: RefundConfirmationModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)
  const modalRef = useFocusTrap({ onClose: onCancel, disabled: submitting || isRetrying })

  const handleConfirm = async () => {
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unknown error occurred"
      // Distinguish between network/RPC errors and contract rejections
      if (errorMessage.includes("rejected") || errorMessage.includes("contract")) {
        setError(`Contract Rejection: ${errorMessage}`)
      } else if (errorMessage.includes("network") || errorMessage.includes("RPC")) {
        setError(`Network Error: ${errorMessage}`)
      } else {
        setError(`Error: ${errorMessage}`)
      }
    }
  }

  const handleRetry = async () => {
    setIsRetrying(true)
    await handleConfirm()
    setIsRetrying(false)
  }

  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        ref={modalRef}
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-confirm-title"
        tabIndex={-1}
      >
        <h2 id="refund-confirm-title">Request Refund</h2>
        
        {error && (
          <div className="modal-error-state" role="alert" aria-live="assertive">
            <div className="error-icon">⚠️</div>
            <div className="error-content">
              <h3>Transaction Failed</h3>
              <p className="error-message">{error}</p>
              <p className="error-hint">
                {error.includes("Contract Rejection") 
                  ? "The contract rejected your request. Check the invoice details and try again."
                  : "There was a network issue. Please check your connection and retry."}
              </p>
            </div>
          </div>
        )}

        {!error && (
          <>
            <p className="modal-desc">
              You are about to request a refund for this paid invoice. This will
              transition the invoice to{" "}
              <strong>RefundRequested</strong> status and initiate the escrow
              dispute process.
            </p>

            <div className="modal-details">
              <div className="detail-row">
                <span className="detail-label">Invoice ID</span>
                <span className="detail-value">#<CopyableText text={String(invoice.id)} label="Copy invoice ID" /></span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Paid Amount</span>
                <span className="detail-value">{formatAmount(invoice.gross_usdc, USDC_DECIMALS, "USDC")}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Merchant</span>
                <span className="detail-value detail-value--address">
                  <CopyableText text={invoice.merchant} label="Copy merchant address" />
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Current Status</span>
                <StatusBadge status={invoice.status} />
              </div>
            </div>
          </>
        )}

        <div className="modal-actions" role="group" aria-label="Refund confirmation actions">
          <button
            className="btn btn--secondary"
            onClick={error ? onCancel : onCancel}
            disabled={submitting || isRetrying}
            aria-label={error ? "Close error and go back" : "Cancel refund request"}
          >
            {error ? "Go Back" : "Cancel"}
          </button>
          <button
            className={error ? "btn btn--primary" : "btn btn--danger"}
            onClick={error ? handleRetry : handleConfirm}
            disabled={submitting || isRetrying}
            aria-label={
              error 
                ? (isRetrying ? "Retrying refund request" : "Retry refund request")
                : (submitting ? "Submitting refund request" : "Confirm refund request")
            }
          >
            {error ? (isRetrying ? "Retrying..." : "Retry") : (submitting ? "Submitting..." : "Confirm Refund Request")}
          </button>
        </div>
      </div>
    </div>
  )
}
