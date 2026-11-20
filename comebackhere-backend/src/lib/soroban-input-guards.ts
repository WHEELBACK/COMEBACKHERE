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
