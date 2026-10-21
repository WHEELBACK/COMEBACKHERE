import { describe, it, expect, vi } from "vitest"
import { emitPaymentCompleted, PAYMENT_COMPLETED_EVENT } from "../utils/invoiceEvents"

describe("emitPaymentCompleted", () => {
  it("dispatches a window event with the invoice id", () => {
    const handler = vi.fn()
    window.addEventListener(PAYMENT_COMPLETED_EVENT, handler)
    emitPaymentCompleted("42")
    window.removeEventListener(PAYMENT_COMPLETED_EVENT, handler)
    expect(handler).toHaveBeenCalledTimes(1)
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ invoiceId: "42" })
  })
})
