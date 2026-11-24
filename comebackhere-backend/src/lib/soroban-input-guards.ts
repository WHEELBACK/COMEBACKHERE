import { StrKey } from "stellar-sdk"

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

/** Rejects anything that is not a well-formed Soroban contract address (C...). */
export function assertContractId(value: unknown, label = "contract id"): string {
  if (typeof value !== "string" || !StrKey.isValidContract(value)) bad(`Invalid ${label}`)
  return value
}

/** Rejects holder addresses that are neither a valid account (G...) nor contract (C...) strkey. */
export function assertHolderAddress(value: unknown, label = "address"): string {
  if (typeof value !== "string" || !(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    bad(`Invalid ${label}`)
  }
  return value
}

/** Soroban symbols: letters, digits, underscore, at most 32 chars. */
export function assertMethodName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value)) bad("Invalid contract method name")
  return value
}

/**
 * Validates a Soroban contract address used as a reporting-engine input boundary.
 * Rejects non-strings, malformed strkeys, and unexpected whitespace/control characters
 * before the value can reach any downstream query or RPC call.
 */
export function assertReportingContractId(value: unknown, label = "contract id"): string {
  if (typeof value !== "string") bad(`Invalid ${label}`)
  if (value.length === 0 || value.length > 64) bad(`Invalid ${label}`)
  if (/[\s\u0000-\u001f\u007f]/.test(value)) bad(`Invalid ${label}`)
  if (!StrKey.isValidContract(value)) bad(`Invalid ${label}`)
  return value
}

/**
 * Validates a Soroban method name used as a reporting-engine input boundary.
 * Enforces the symbol charset/length and rejects control characters or whitespace
 * to prevent injection through unvalidated method names.
 */
export function assertReportingMethodName(value: unknown, label = "contract method name"): string {
  if (typeof value !== "string") bad(`Invalid ${label}`)
  if (value.length === 0 || value.length > 32) bad(`Invalid ${label}`)
  if (/[\s\u0000-\u001f\u007f]/.test(value)) bad(`Invalid ${label}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value)) bad(`Invalid ${label}`)
  return value
}

/**
 * Validates a holder address (account or contract) used as a reporting-engine input boundary.
 * Rejects control characters and whitespace in addition to strkey validation.
 */
export function assertReportingHolderAddress(value: unknown, label = "address"): string {
  if (typeof value !== "string") bad(`Invalid ${label}`)
  if (value.length === 0 || value.length > 64) bad(`Invalid ${label}`)
  if (/[\s\u0000-\u001f\u007f]/.test(value)) bad(`Invalid ${label}`)
  if (!(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) bad(`Invalid ${label}`)
  return value
}