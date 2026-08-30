import { render, screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { EscrowRelease } from "../components/EscrowRelease"

const merchantAddress = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"

const mockInvoice = {
  id: "42",
  merchant: merchantAddress,
  payer: "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount_usdc: "1000",
  gross_usdc: "1050",
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  status: "Paid" as const,
  paid_at: 1700000000,
  metadata_hash: null,
  payment_link_hash: null,
}

let mockUseInvoice: any
let mockUseWallet: any
const fetchBalancesMock = vi.fn()

vi.mock("../hooks/useInvoice", () => ({
  useInvoice: () => mockUseInvoice,
}))

vi.mock("../hooks/useWallet", () => ({
  useWallet: () => mockUseWallet,
}))

vi.mock("../utils/treasury", () => ({
  fetchBalances: (address: string) => fetchBalancesMock(address),
}))

beforeEach(() => {
  fetchBalancesMock.mockReset()
  fetchBalancesMock.mockResolvedValue([{ token: "USDC", balance: "5000" }])

  mockUseInvoice = {
    invoice: mockInvoice,
    loading: false,
    error: null,
    loadInvoice: vi.fn(),
    release: vi.fn(),
  }
  mockUseWallet = {
    address: merchantAddress,
    connected: true,
    connecting: false,
    connect: vi.fn(),
  }
})

describe("EscrowRelease treasury balance", () => {
  it("fetches and displays the treasury's current USDC balance for a Paid invoice", async () => {
    render(<EscrowRelease />)

    await waitFor(() => expect(fetchBalancesMock).toHaveBeenCalled())
    expect(await screen.findByText("Treasury USDC Balance")).toBeInTheDocument()
    expect(await screen.findByText("5000")).toBeInTheDocument()
  })

  it("does not fetch a treasury balance for a non-Paid invoice", () => {
    mockUseInvoice.invoice = { ...mockInvoice, status: "Pending" }
    render(<EscrowRelease />)

    expect(screen.queryByText("Treasury USDC Balance")).not.toBeInTheDocument()
    expect(fetchBalancesMock).not.toHaveBeenCalled()
  })

  it("enables release when the treasury balance covers the invoice amount", async () => {
    fetchBalancesMock.mockResolvedValue([{ token: "USDC", balance: "1000" }])
    render(<EscrowRelease />)

    const releaseButton = await screen.findByRole("button", { name: "Release Escrow" })
    await waitFor(() => expect(releaseButton).not.toBeDisabled())
  })

  it("disables release and shows an inline warning when the treasury balance is insufficient", async () => {
    fetchBalancesMock.mockResolvedValue([{ token: "USDC", balance: "500" }])
    render(<EscrowRelease />)

    await waitFor(() => expect(fetchBalancesMock).toHaveBeenCalled())
    const releaseButton = await screen.findByRole("button", { name: "Release Escrow" })
    expect(releaseButton).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(/below this invoice's amount/i)
  })

  it("shows an unavailable state when the balance fetch fails", async () => {
    fetchBalancesMock.mockRejectedValue(new Error("network error"))
    render(<EscrowRelease />)

    expect(await screen.findByText("Unavailable")).toBeInTheDocument()
  })
})
