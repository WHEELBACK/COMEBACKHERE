import { useState, useRef, type FormEvent, type ChangeEvent } from "react"
import { CopyableText } from "./CopyableText"
import { InvoiceQRCode } from "./InvoiceQRCode"
import { createInvoice, ApiError, type CreateInvoiceResponse } from "../utils/api"
import {
  INVOICE_TOKENS,
  INVOICE_TOKEN_CODES,
  parseDueDate,
  toDateTimeLocal,
  toSmallestUnit,
  validateInvoiceForm,
  type InvoiceFormErrors,
  type InvoiceFormField,
  type InvoiceFormValues,
  type InvoiceToken,
} from "../utils/invoiceForm"

interface CreateInvoiceProps {
  /** Connected wallet address, used as the invoice's merchant. */
  merchantAddress: string | null
}

const EMPTY_VALUES: InvoiceFormValues = {
  customer: "",
  amount: "",
  token: "USDC",
  dueDate: "",
}

const FIELD_ORDER: InvoiceFormField[] = ["customer", "amount", "token", "dueDate"]

/** Map backend validation field names onto form fields. */
const SERVER_FIELD_MAP: Record<string, InvoiceFormField> = {
  customer_address: "customer",
  amount: "amount",
  token: "token",
  due_date: "dueDate",
}

interface CreatedInvoice extends CreateInvoiceResponse {
  amount: string
  token: InvoiceToken
  customer: string
  dueDate: number
}

export function CreateInvoice({ merchantAddress }: CreateInvoiceProps) {
  const [values, setValues] = useState<InvoiceFormValues>(EMPTY_VALUES)
  const [touched, setTouched] = useState<Partial<Record<InvoiceFormField, boolean>>>({})
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverFieldErrors, setServerFieldErrors] = useState<InvoiceFormErrors>({})
  const [created, setCreated] = useState<CreatedInvoice | null>(null)
  const fieldRefs = useRef<Partial<Record<InvoiceFormField, HTMLInputElement | HTMLSelectElement | null>>>({})

  const clientErrors = validateInvoiceForm(values, { merchantAddress })
  const visibleErrors: InvoiceFormErrors = { ...serverFieldErrors }
  for (const field of FIELD_ORDER) {
    if ((attempted || touched[field]) && clientErrors[field]) {
      visibleErrors[field] = clientErrors[field]
    }
  }

  const handleChange = (field: InvoiceFormField) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value
    setValues((prev) => ({ ...prev, [field]: value }))
    setServerFieldErrors((prev) => ({ ...prev, [field]: undefined }))
    setServerError(null)
  }

  const handleBlur = (field: InvoiceFormField) => () => {
    setTouched((prev) => ({ ...prev, [field]: true }))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting || !merchantAddress) return
    setAttempted(true)
    setServerError(null)
    setServerFieldErrors({})

    const errors = validateInvoiceForm(values, { merchantAddress })
    const firstInvalid = FIELD_ORDER.find((field) => errors[field])
    if (firstInvalid) {
      fieldRefs.current[firstInvalid]?.focus()
      return
    }

    const units = toSmallestUnit(values.amount, INVOICE_TOKENS[values.token]) as bigint
    const dueDate = parseDueDate(values.dueDate) as number
    const customer = values.customer.trim()

    setSubmitting(true)
    try {
      const result = await createInvoice({
        merchant_address: merchantAddress,
        customer_address: customer,
        token: values.token,
        amount: Number(units),
        due_date: dueDate,
      })
      setCreated({ ...result, amount: values.amount.trim(), token: values.token, customer, dueDate })
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        const fieldErrors: InvoiceFormErrors = {}
        for (const detail of err.details) {
          const field = SERVER_FIELD_MAP[detail.field]
          if (field) fieldErrors[field] = detail.message
        }
        setServerFieldErrors(fieldErrors)
        setServerError(err.message)
      } else {
        setServerError(err instanceof Error ? err.message : "Failed to create invoice")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleReset = () => {
    setValues(EMPTY_VALUES)
    setTouched({})
    setAttempted(false)
    setServerError(null)
    setServerFieldErrors({})
    setCreated(null)
  }

  if (created) {
    return (
      <div className="create-invoice">
        <h2>Invoice Created</h2>
        <div className="message message--success" role="status">
          Invoice created. Share the ID or QR code with your customer so they can pay.
        </div>
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h3>
              Invoice #<CopyableText text={created.invoice_id} label="Copy invoice ID" />
            </h3>
          </div>
          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Amount</span>
              <span className="detail-value">{created.amount} {created.token}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Customer</span>
              <span className="detail-value detail-value--address">
                <CopyableText text={created.customer} label="Copy customer address" />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Due</span>
              <span className="detail-value">{new Date(created.dueDate * 1000).toLocaleString()}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <span className="detail-value">{created.status}</span>
            </div>
          </div>
        </div>
        <InvoiceQRCode invoiceId={created.invoice_id} />
        <button type="button" className="btn btn--secondary" onClick={handleReset}>
          Create another invoice
        </button>
      </div>
    )
  }

  const fieldProps = (field: InvoiceFormField) => ({
    id: `create-invoice-${field}`,
    name: field,
    value: values[field],
    onChange: handleChange(field),
    onBlur: handleBlur(field),
    disabled: submitting,
    "aria-invalid": visibleErrors[field] ? true : undefined,
    "aria-describedby": `create-invoice-${field}-${visibleErrors[field] ? "error" : "hint"}`,
    className: `form-field__input ${visibleErrors[field] ? "form-field__input--error" : ""}`,
    ref: (el: HTMLInputElement | HTMLSelectElement | null) => {
      fieldRefs.current[field] = el
    },
  })

  const renderMessage = (field: InvoiceFormField, hint: string) =>
    visibleErrors[field] ? (
      <p id={`create-invoice-${field}-error`} className="form-field__error" role="alert">
        {visibleErrors[field]}
      </p>
    ) : (
      <p id={`create-invoice-${field}-hint`} className="form-field__hint">
        {hint}
      </p>
    )

  const decimals = INVOICE_TOKENS[values.token]
  const units = values.amount ? toSmallestUnit(values.amount, decimals) : null
  const amountHint =
    units !== null && units > 0n
      ? `Sent as ${units.toString()} base units (${decimals} decimals)`
      : `Up to ${decimals} decimal places`

  return (
    <div className="create-invoice">
      <h2>Create Invoice</h2>

      {!merchantAddress && (
        <div className="message message--warning" role="status">
          Connect your wallet to create invoices. Your connected address is used as the merchant.
        </div>
      )}

      {serverError && (
        <div className="message message--error" role="alert" data-testid="create-invoice-server-error">
          {serverError}
        </div>
      )}

      <form className="create-invoice__form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
        <div className="form-field">
          <label htmlFor="create-invoice-customer" className="form-field__label">
            Customer address <span className="required">*</span>
          </label>
          <input
            {...fieldProps("customer")}
            type="text"
            placeholder="G..."
            autoComplete="off"
            spellCheck={false}
          />
          {renderMessage("customer", "Stellar address of the customer who will pay this invoice")}
        </div>

        <div className="create-invoice__row">
          <div className="form-field">
            <label htmlFor="create-invoice-amount" className="form-field__label">
              Amount <span className="required">*</span>
            </label>
            <input {...fieldProps("amount")} type="text" inputMode="decimal" placeholder="0.00" />
            {renderMessage("amount", amountHint)}
          </div>

          <div className="form-field">
            <label htmlFor="create-invoice-token" className="form-field__label">
              Token <span className="required">*</span>
            </label>
            <select {...fieldProps("token")}>
              {INVOICE_TOKEN_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            {renderMessage("token", "Token the customer pays in")}
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="create-invoice-dueDate" className="form-field__label">
            Due date <span className="required">*</span>
          </label>
          <input {...fieldProps("dueDate")} type="datetime-local" min={toDateTimeLocal(new Date())} />
          {renderMessage("dueDate", "The invoice expires if unpaid by this time")}
        </div>

        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || !merchantAddress}
          data-testid="create-invoice-submit"
        >
          {submitting ? "Creating invoice..." : "Create Invoice"}
        </button>
      </form>
    </div>
  )
}
