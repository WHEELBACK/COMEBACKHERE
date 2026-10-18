import { StrKey } from "soroban-client"

/** Tokens a merchant can invoice in, with their on-chain decimals. */
export const INVOICE_TOKENS = {
  USDC: 7,
  EURC: 7,
  XLM: 7,
} as const

export type InvoiceToken = keyof typeof INVOICE_TOKENS

export const INVOICE_TOKEN_CODES = Object.keys(INVOICE_TOKENS) as InvoiceToken[]

export interface InvoiceFormValues {
  customer: string
  amount: string
  token: InvoiceToken
  /** Value of a datetime-local input, e.g. "2026-10-01T12:00" */
  dueDate: string
}

export type InvoiceFormField = keyof InvoiceFormValues

export type InvoiceFormErrors = Partial<Record<InvoiceFormField, string>>

export function isValidStellarAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value)
}

/**
 * Convert a decimal amount string into the token's smallest unit.
 * Returns null when the string is not a plain non-negative decimal or has
 * more fractional digits than the token supports.
 */
export function toSmallestUnit(amount: string, decimals: number): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim())
  if (!match || (match[1] === "" && !match[2])) return null
  const [, whole, fraction = ""] = match
  if (fraction.length > decimals) return null
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")
}

/** Format an amount in the token's smallest unit as a decimal string. */
export function fromSmallestUnit(units: number | string | bigint, decimals: number): string {
  let value: bigint
  try {
    value = BigInt(units)
  } catch {
    return String(units)
  }
  const negative = value < 0n
  if (negative) value = -value
  const base = 10n ** BigInt(decimals)
  const whole = (value / base).toString()
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}

/** Parse a datetime-local value into a Unix timestamp in seconds. */
export function parseDueDate(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/** Format a Date for the min attribute of a datetime-local input. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function validateInvoiceForm(
  values: InvoiceFormValues,
  { merchantAddress, now = Date.now() }: { merchantAddress?: string | null; now?: number } = {}
): InvoiceFormErrors {
  const errors: InvoiceFormErrors = {}

  const customer = values.customer.trim()
  if (!customer) {
    errors.customer = "Customer address is required"
  } else if (!isValidStellarAddress(customer)) {
    errors.customer = "Enter a valid Stellar address (starts with G, 56 characters)"
  } else if (merchantAddress && customer === merchantAddress) {
    errors.customer = "Customer address must differ from your merchant address"
  }

  const decimals = INVOICE_TOKENS[values.token]
  if (decimals === undefined) {
    errors.token = "Select a supported token"
  }

  const amount = values.amount.trim()
  if (!amount) {
    errors.amount = "Amount is required"
  } else if (decimals !== undefined) {
    const units = toSmallestUnit(amount, decimals)
    if (units === null) {
      errors.amount = /^\d*\.\d+$/.test(amount)
        ? `${values.token} supports at most ${decimals} decimal places`
        : "Enter a number, e.g. 25.50"
    } else if (units <= 0n) {
      errors.amount = "Amount must be greater than zero"
    } else if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
      errors.amount = "Amount is too large"
    }
  }

  const due = parseDueDate(values.dueDate)
  if (!values.dueDate) {
    errors.dueDate = "Due date is required"
  } else if (due === null) {
    errors.dueDate = "Enter a valid date and time"
  } else if (due * 1000 <= now) {
    errors.dueDate = "Due date must be in the future"
  }

  return errors
}
