/**
 * Classification of wallet errors so a user declining a request is not
 * reported as an unexpected application failure.
 */

const REJECTION_PATTERNS = ["user rejected", "user declined", "rejected", "declined", "denied", "cancelled", "canceled", "not approved"]

export const WALLET_REJECTED_MESSAGE = "Request cancelled in your wallet. No transaction was sent."

/** True when the message indicates the user rejected the wallet prompt. */
export function isWalletRejection(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return REJECTION_PATTERNS.some((pattern) => lower.includes(pattern))
}

/** Replace a raw wallet rejection with a friendly, non-error message. */
export function friendlyWalletError<T extends { success: boolean; error?: string }>(result: T): T {
  if (result.success || !isWalletRejection(result.error)) return result
  return { ...result, error: WALLET_REJECTED_MESSAGE }
}
