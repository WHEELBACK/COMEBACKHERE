/** Window event fired once a payment has been confirmed, so lists can refetch. */
export const PAYMENT_COMPLETED_EVENT = "comebackhere:payment-completed"

export function emitPaymentCompleted(invoiceId?: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(PAYMENT_COMPLETED_EVENT, { detail: { invoiceId } }))
}
