/**
 * Restrict raw amount input to digits and one decimal point, truncating
 * fractional digits beyond what the token supports.
 */
export function limitFractionDigits(value: string, decimals: number): string {
  const dot = value.indexOf(".")
  if (dot === -1) return value
  const whole = value.slice(0, dot)
  const fraction = value.slice(dot + 1).replace(/\./g, "")
  return `${whole}.${fraction.slice(0, decimals)}`
}
