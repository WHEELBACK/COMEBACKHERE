/**
 * Amount formatting for on-chain token values.
 *
 * Soroban/Stellar tokens store amounts as integers in the smallest unit
 * (stroops for classic assets: 7 decimals). `formatAmount` is the single way
 * the UI turns those raw integers into human-readable strings.
 *
 * All arithmetic is done with bigint so amounts beyond
 * Number.MAX_SAFE_INTEGER keep full precision; Intl.NumberFormat supplies the
 * locale's digit grouping, decimal separator and minus sign.
 */

/** Decimals used by Stellar classic assets (1 unit = 10^7 stroops). */
export const STELLAR_DECIMALS = 7

/** USDC on Stellar uses the classic-asset precision. */
export const USDC_DECIMALS = STELLAR_DECIMALS

export type RawAmount = bigint | string | number

export interface FormatAmountOptions {
  /** BCP 47 locale. Defaults to "en-US" so amounts look the same everywhere. */
  locale?: string
  /** Fraction digits always shown (padded with zeros). Default 2. */
  minimumFractionDigits?: number
  /** Fraction digits kept after rounding. Defaults to `decimals` (full precision). */
  maximumFractionDigits?: number
}

/** Shown in place of an amount that cannot be parsed. */
export const INVALID_AMOUNT = "—"

const DEFAULT_LOCALE = "en-US"

/**
 * Parse a raw integer amount without going through floating point.
 * Throws RangeError for non-integers, unsafe JS numbers or malformed strings.
 */
export function toRawBigInt(raw: RawAmount): bigint {
  if (typeof raw === "bigint") return raw
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) {
      throw new RangeError(`Raw amount must be a safe integer, got ${raw}`)
    }
    return BigInt(raw)
  }
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RangeError(`Raw amount must be an integer string, got "${raw}"`)
  }
  return BigInt(trimmed)
}

interface LocaleParts {
  integer: Intl.NumberFormat
  decimal: string
  minus: string
}

const localeCache = new Map<string, LocaleParts>()

function localeParts(locale: string): LocaleParts {
  let parts = localeCache.get(locale)
  if (!parts) {
    const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    const sample = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 }).formatToParts(-1.5)
    parts = {
      integer,
      decimal: sample.find((p) => p.type === "decimal")?.value ?? ".",
      minus: sample.find((p) => p.type === "minusSign")?.value ?? "-",
    }
    localeCache.set(locale, parts)
  }
  return parts
}

/**
 * Format a raw integer token amount for display.
 *
 * @param raw      Amount in the token's smallest unit (bigint, integer string or safe integer).
 * @param decimals Number of decimals the token uses (7 for Stellar classic assets).
 * @param symbol   Optional token symbol appended after the number, e.g. "USDC".
 *
 * Rounds half away from zero when `maximumFractionDigits` is below `decimals`.
 *
 * @example formatAmount(10_500_000n, 7, "USDC") // "1.05 USDC"
 * @example formatAmount("1", 7, "XLM")          // "0.0000001 XLM"
 */
export function formatAmount(
  raw: RawAmount,
  decimals: number = STELLAR_DECIMALS,
  symbol?: string,
  options: FormatAmountOptions = {}
): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`)
  }

  let value: bigint
  try {
    value = toRawBigInt(raw)
  } catch {
    return INVALID_AMOUNT
  }

  const maxFraction = Math.max(0, options.maximumFractionDigits ?? decimals)
  const minFraction = Math.min(Math.max(0, options.minimumFractionDigits ?? 2), maxFraction)

  const negative = value < 0n
  let abs = negative ? -value : value

  // Round to maxFraction digits (half away from zero), or pad if more
  // digits are requested than the token has.
  let fractionDigits = decimals
  if (maxFraction < decimals) {
    const divisor = 10n ** BigInt(decimals - maxFraction)
    const remainder = abs % divisor
    abs = abs / divisor + (remainder * 2n >= divisor ? 1n : 0n)
    fractionDigits = maxFraction
  }

  const scale = 10n ** BigInt(fractionDigits)
  const integerPart = abs / scale
  let fraction = fractionDigits > 0 ? (abs % scale).toString().padStart(fractionDigits, "0") : ""

  fraction = fraction.replace(/0+$/, "")
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0")

  const { integer, decimal, minus } = localeParts(options.locale ?? DEFAULT_LOCALE)
  const isZero = abs === 0n
  const number =
    (negative && !isZero ? minus : "") +
    integer.format(integerPart) +
    (fraction ? decimal + fraction : "")

  return symbol ? `${number} ${symbol}` : number
}

/** Compare two raw amounts exactly: negative if a < b, 0 if equal, positive if a > b. */
export function compareRawAmounts(a: RawAmount, b: RawAmount): number {
  const x = toRawBigInt(a)
  const y = toRawBigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}
