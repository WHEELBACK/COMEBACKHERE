import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SorobanClient } from "../lib/soroban.js"

const soroban = vi.hoisted(() => ({
  buildSorobanClient: vi.fn(),
  simulateContractRead: vi.fn(),
  submitContractCall: vi.fn(),
}))

vi.mock("../lib/soroban.js", () => soroban)

import { applyInvoiceAction } from "../routes/invoice-actions.js"

const ENV = {
  rpcUrl: "http://localhost:8000",
  invoiceContractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
  signerSecret: "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ",
  networkPassphrase: "Standalone Network ; February 2025",
}

const CLIENT = {} as SorobanClient

function statusValue(status: string) {
  return { vec: () => [{ sym: () => ({ toString: () => status }) }] }
}

describe("invoice state-transition routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    soroban.simulateContractRead.mockResolvedValue(statusValue("Paid"))
    soroban.submitContractCall.mockResolvedValue("tx-hash")
  })

  it("cancels a Pending invoice and reports Cancelled", async () => {
    soroban.simulateContractRead.mockResolvedValue(statusValue("Pending"))
    await expect(applyInvoiceAction("cancel_invoiced", "42", ENV, CLIENT)).resolves.toEqual({
      invoice_id: "42",
      status: "Cancelled",
      tx_hash: "tx-hash",
    })
    expect(soroban.submitContractCall).toHaveBeenCalledWith(
      CLIENT,
      ENV.invoiceContractId,
      "cancel_invoiced",
      expect.any(Array),
      ENV.signerSecret,
      ENV.networkPassphrase,
    )
  })

  it("cancelling a Paid invoice reports RefundRequested", async () => {
    await expect(applyInvoiceAction("cancel_invoiced", "42", ENV, CLIENT)).resolves.toMatchObject({
      status: "RefundRequested",
    })
  })

  it("requests a refund and returns the updated status", async () => {
    await expect(applyInvoiceAction("request_refund", "42", ENV, CLIENT)).resolves.toMatchObject({
      status: "RefundRequested",
      tx_hash: "tx-hash",
    })
  })

  it("returns 404 for an unknown invoice", async () => {
    soroban.simulateContractRead.mockRejectedValue(new Error("Error(Contract, #4)"))
    await expect(applyInvoiceAction("cancel_invoiced", "999", ENV, CLIENT)).rejects.toMatchObject({ status: 404 })
  })

  it("maps unauthorized cancellation to 403", async () => {
    soroban.submitContractCall.mockRejectedValue(new Error("Error(Contract, #1)"))
    await expect(applyInvoiceAction("cancel_invoiced", "42", ENV, CLIENT)).rejects.toMatchObject({
      status: 403,
      details: { contractCode: 1 },
    })
  })

  it("maps invalid cancellation state to 409", async () => {
    soroban.submitContractCall.mockRejectedValue(new Error("Error(Contract, #7)"))
    await expect(applyInvoiceAction("cancel_invoiced", "42", ENV, CLIENT)).rejects.toMatchObject({
      status: 409,
      details: { contractCode: 7 },
    })
  })

  it("rejects refunds for invoices that are not Paid with a contract code", async () => {
    soroban.simulateContractRead.mockResolvedValue(statusValue("Pending"))
    await expect(applyInvoiceAction("request_refund", "42", ENV, CLIENT)).rejects.toMatchObject({
      status: 409,
      details: { contractCode: 4 },
    })
    expect(soroban.submitContractCall).not.toHaveBeenCalled()
  })

  it("maps a pending refund to 409", async () => {
    soroban.submitContractCall.mockRejectedValue(new Error("Error(Contract, #11)"))
    await expect(applyInvoiceAction("request_refund", "42", ENV, CLIENT)).rejects.toMatchObject({
      status: 409,
      details: { contractCode: 11 },
    })
  })
})