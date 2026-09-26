import { useState } from "react"
import { config } from "../config"

interface DisputeResult {
  dispute_id: string
  settlement_id: string
  claimant_address: string
  status: string
  settlement_status: string
}

interface FormErrors {
  claimant_address?: string
  settlement_id?: string
  reason?: string
}

const MIN_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 500

/** Basic Stellar public key format check (G…, 56 chars). */
function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address)
}

function validate(fields: {
  claimant_address: string
  settlement_id: string
  reason: string
}): FormErrors {
  const errors: FormErrors = {}

  if (!fields.claimant_address.trim()) {
    errors.claimant_address = "Claimant address is required"
  } else if (!isValidStellarAddress(fields.claimant_address.trim())) {
    errors.claimant_address = "Must be a valid Stellar public key (starts with G, 56 characters)"
  }

  if (!fields.settlement_id.trim()) {
    errors.settlement_id = "Settlement ID is required"
  } else if (!/^\d+$/.test(fields.settlement_id.trim()) || Number(fields.settlement_id) < 1) {
    errors.settlement_id = "Settlement ID must be a positive integer"
  }

  if (!fields.reason.trim()) {
    errors.reason = "Reason is required"
  } else if (fields.reason.trim().length < MIN_REASON_LENGTH) {
    errors.reason = `Reason must be at least ${MIN_REASON_LENGTH} characters`
  } else if (fields.reason.length > MAX_REASON_LENGTH) {
    errors.reason = `Reason must not exceed ${MAX_REASON_LENGTH} characters`
  }

  return errors
}

export function RaiseDispute() {
  const [claimantAddress, setClaimantAddress] = useState("")
  const [settlementId, setSettlementId] = useState("")
  const [reason, setReason] = useState("")
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<DisputeResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleBlur = (field: keyof FormErrors) => {
    setTouched((prev) => ({ ...prev, [field]: true }))
    const fieldErrors = validate({ claimant_address: claimantAddress, settlement_id: settlementId, reason })
    setErrors(fieldErrors)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    const allTouched = { claimant_address: true, settlement_id: true, reason: true }
    setTouched(allTouched)

    const fieldErrors = validate({ claimant_address: claimantAddress, settlement_id: settlementId, reason })
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) return

    setSubmitting(true)
    try {
      const response = await fetch(`${config.apiUrl}/disputes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimant_address: claimantAddress.trim(),
          settlement_id: settlementId.trim(),
          reason: reason.trim(),
        }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        const message = (body as { error?: string }).error ?? `Request failed with status ${response.status}`

        // 400 = validation / state error (e.g. invoice cannot be disputed)
        if (response.status === 400) {
          setSubmitError(`Cannot raise dispute: ${message}`)
        } else {
          setSubmitError(`Error ${response.status}: ${message}`)
        }
        return
      }

      const data: DisputeResult = await response.json()
      setResult(data)
      // Clear form on success
      setClaimantAddress("")
      setSettlementId("")
      setReason("")
      setTouched({})
      setErrors({})
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error
          ? `Network error: ${err.message}`
          : "An unexpected error occurred. Please try again."
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleReset = () => {
    setResult(null)
    setSubmitError(null)
  }

  // --- Success state ---
  if (result) {
    return (
      <div className="raise-dispute">
        <h1>Dispute Raised</h1>
        <div className="message message--success" role="status" aria-live="polite">
          <strong>Dispute submitted successfully.</strong>
          <br />
          The settlement has been placed on hold pending resolution.
        </div>
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h2>Dispute Details</h2>
          </div>
          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Dispute ID</span>
              <span className="detail-value">
                <code>{result.dispute_id}</code>
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Settlement ID</span>
              <span className="detail-value">{result.settlement_id}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Claimant</span>
              <span className="detail-value detail-value--address">{result.claimant_address}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Dispute Status</span>
              <span className="detail-value">{result.status}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Settlement Status</span>
              <span className="detail-value">{result.settlement_status}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: "16px" }}>
          <button className="btn btn--secondary" onClick={handleReset}>
            Raise Another Dispute
          </button>
        </div>
      </div>
    )
  }

  // --- Form state ---
  return (
    <div className="raise-dispute">
      <h1>Raise a Dispute</h1>
      <p className="status-text">
        Use this form to dispute a settlement. Once submitted, the settlement will
        be placed on hold until the dispute is resolved.
      </p>

      {submitError && (
        <div className="message message--error" role="alert">
          {submitError}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate aria-label="Raise dispute form">
        {/* Claimant Address */}
        <div className="form-group" style={{ marginBottom: "16px" }}>
          <label htmlFor="claimant-address" className="form-label">
            Your Stellar Address{" "}
            <span className="required" aria-label="required">*</span>
          </label>
          <input
            id="claimant-address"
            type="text"
            value={claimantAddress}
            onChange={(e) => {
              setClaimantAddress(e.target.value)
              if (touched.claimant_address) {
                const errs = validate({ claimant_address: e.target.value, settlement_id: settlementId, reason })
                setErrors(errs)
              }
            }}
            onBlur={() => handleBlur("claimant_address")}
            placeholder="GABC..."
            aria-invalid={!!(touched.claimant_address && errors.claimant_address)}
            aria-describedby={errors.claimant_address ? "claimant-address-error" : undefined}
            disabled={submitting}
            style={{ width: "100%", marginTop: "4px" }}
          />
          {touched.claimant_address && errors.claimant_address && (
            <p id="claimant-address-error" className="refund-form__error" role="alert">
              {errors.claimant_address}
            </p>
          )}
        </div>

        {/* Settlement ID */}
        <div className="form-group" style={{ marginBottom: "16px" }}>
          <label htmlFor="settlement-id" className="form-label">
            Settlement ID{" "}
            <span className="required" aria-label="required">*</span>
          </label>
          <input
            id="settlement-id"
            type="text"
            inputMode="numeric"
            value={settlementId}
            onChange={(e) => {
              setSettlementId(e.target.value)
              if (touched.settlement_id) {
                const errs = validate({ claimant_address: claimantAddress, settlement_id: e.target.value, reason })
                setErrors(errs)
              }
            }}
            onBlur={() => handleBlur("settlement_id")}
            placeholder="e.g. 5"
            aria-invalid={!!(touched.settlement_id && errors.settlement_id)}
            aria-describedby={errors.settlement_id ? "settlement-id-error" : undefined}
            disabled={submitting}
            style={{ width: "100%", marginTop: "4px" }}
          />
          {touched.settlement_id && errors.settlement_id && (
            <p id="settlement-id-error" className="refund-form__error" role="alert">
              {errors.settlement_id}
            </p>
          )}
        </div>

        {/* Reason */}
        <div className="form-group" style={{ marginBottom: "16px" }}>
          <label htmlFor="dispute-reason" className="form-label">
            Reason{" "}
            <span className="required" aria-label="required">*</span>
            <span className="refund-form__hint" style={{ display: "block", fontWeight: "normal" }}>
              Minimum {MIN_REASON_LENGTH} characters. Describe why you are disputing this settlement.
            </span>
          </label>
          <textarea
            id="dispute-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              if (touched.reason) {
                const errs = validate({ claimant_address: claimantAddress, settlement_id: settlementId, reason: e.target.value })
                setErrors(errs)
              }
            }}
            onBlur={() => handleBlur("reason")}
            placeholder="e.g. Goods were not delivered as agreed, payment was made but settlement was not executed, etc."
            maxLength={MAX_REASON_LENGTH}
            rows={4}
            aria-invalid={!!(touched.reason && errors.reason)}
            aria-describedby={errors.reason ? "reason-error" : "reason-hint"}
            disabled={submitting}
            style={{ width: "100%", marginTop: "4px", resize: "vertical" }}
          />
          {touched.reason && errors.reason ? (
            <p id="reason-error" className="refund-form__error" role="alert">
              {errors.reason}
            </p>
          ) : (
            <p id="reason-hint" className="refund-form__counter">
              {reason.length} / {MAX_REASON_LENGTH} characters
            </p>
          )}
        </div>

        <button
          type="submit"
          className="btn btn--danger"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? "Submitting…" : "Submit Dispute"}
        </button>
      </form>
    </div>
  )
}
