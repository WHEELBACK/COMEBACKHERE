import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { InvoiceStatus } from "../types"
import { useInvoice } from "../hooks/useInvoice"
import { fetchInvoice, cancelInvoice } from "../utils/soroban"

vi.mock("../utils/soroban", () => ({
  fetchInvoice: vi.fn(),
  payInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  requestRefund: vi.fn(),
  releaseEscrow: vi.fn(),
}))

const invoice = {
  id: "42",
  merchant: "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT",
  payer: "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount_usdc: "1000",
  gross_usdc: "1050",
  expires_at: 2000000000,
  status: InvoiceStatus.Pending,
  paid_at: null,
  metadata_hash: null,
  payment_link_hash: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useInvoice cancellation", () => {
  it("shows Cancelled immediately and rolls back when cancellation fails", async () => {
    vi.mocked(fetchInvoice).mockResolvedValue(invoice)
    let resolveCancellation: (result: { success: boolean; error: string }) => void = () => {}
    vi.mocked(cancelInvoice).mockReturnValue(new Promise((resolve) => {
      resolveCancellation = resolve
    }))

    const { result } = renderHook(() => useInvoice())
    await act(async () => {
      await result.current.loadInvoice(42)
    })

    let cancellation: Promise<unknown>
    act(() => {
      cancellation = result.current.cancel(invoice.merchant)
    })
    expect(result.current.invoice?.status).toBe(InvoiceStatus.Cancelled)

    await act(async () => {
      resolveCancellation({ success: false, error: "Cancellation rejected" })
      await cancellation
    })

    expect(result.current.invoice?.status).toBe(InvoiceStatus.Pending)
  })
})
