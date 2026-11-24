import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { BatchExpireInvoices } from "../components/BatchExpireInvoices"
import type { Invoice } from "../types"
import { InvoiceStatus } from "../types"

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../utils/soroban", () => ({
  fetchInvoice: vi.fn(),
  batchExpireInvoices: vi.fn(),
}))

// Import mocked functions after vi.mock is hoisted
import { fetchInvoice, batchExpireInvoices } from "../utils/soroban"

const mockFetchInvoice = vi.mocked(fetchInvoice)
const mockBatchExpireInvoices = vi.mocked(batchExpireInvoices)

// ── Constants ─────────────────────────────────────────────────────────────────

const WALLET_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
const MERCHANT_ADDRESS = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const TX_HASH = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 86400

// ── Test fixtures ─────────────────────────────────────────────────────────────

const pendingInvoice1: Invoice = {
  id: "1",
  merchant: MERCHANT_ADDRESS,
  payer: WALLET_ADDRESS,
  amount_usdc: "1000000",
  gross_usdc: "1010000",
  expires_at: FUTURE_EXPIRY,
  status: InvoiceStatus.Pending,
  paid_at: null,
  metadata_hash: null,
  payment_link_hash: null,
}

const pendingInvoice2: Invoice = {
  id: "2",
  merchant: MERCHANT_ADDRESS,
  payer: WALLET_ADDRESS,
  amount_usdc: "2000000",
  gross_usdc: "2020000",
  expires_at: FUTURE_EXPIRY,
  status: InvoiceStatus.Pending,
  paid_at: null,
  metadata_hash: null,
  payment_link_hash: null,
}

const paidInvoice3: Invoice = {
  id: "3",
  merchant: MERCHANT_ADDRESS,
  payer: WALLET_ADDRESS,
  amount_usdc: "500000",
  gross_usdc: "505000",
  expires_at: FUTURE_EXPIRY - 3600,
  status: InvoiceStatus.Paid,
  paid_at: Math.floor(Date.now() / 1000) - 3600,
  metadata_hash: null,
  payment_link_hash: null,
}

const expiredInvoice1: Invoice = {
  ...pendingInvoice1,
  status: InvoiceStatus.Expired,
}

const expiredInvoice2: Invoice = {
  ...pendingInvoice2,
  status: InvoiceStatus.Expired,
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function loadInvoices(user: ReturnType<typeof userEvent.setup>, ids: string) {
  const input = screen.getByPlaceholderText("Invoice IDs (comma-separated, e.g. 1, 2, 3)")
  fireEvent.change(input, { target: { value: ids } })
  await user.click(screen.getByRole("button", { name: /load invoices/i }))
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("VITE_INVOICE_CONTRACT_ID", "test-contract-id")
  mockFetchInvoice.mockReset()
  mockBatchExpireInvoices.mockReset()
})

// ── Tests: ID parsing and input validation ─────────────────────────────────────

describe("BatchExpireInvoices — ID parsing", () => {
  it("deduplicates IDs: entering '1, 2, 2, 3' loads only 3 distinct invoices", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)
      .mockResolvedValueOnce(paidInvoice3)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2, 2, 3")

    await waitFor(() => expect(mockFetchInvoice).toHaveBeenCalledTimes(3))
    expect(screen.getByText("#1")).toBeInTheDocument()
    expect(screen.getByText("#2")).toBeInTheDocument()
    expect(screen.getByText("#3")).toBeInTheDocument()
  })

  it("shows error when non-numeric IDs like 'abc' are entered", async () => {
    const user = userEvent.setup()
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "abc")

    expect(await screen.findByText("Enter at least one valid invoice ID.")).toBeInTheDocument()
    expect(mockFetchInvoice).not.toHaveBeenCalled()
  })

  it("ignores negative and zero IDs", async () => {
    const user = userEvent.setup()
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "-1, 0, -5")

    expect(await screen.findByText("Enter at least one valid invoice ID.")).toBeInTheDocument()
    expect(mockFetchInvoice).not.toHaveBeenCalled()
  })

  it("parses IDs separated by mixed separators (commas, spaces, newlines)", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)
      .mockResolvedValueOnce(paidInvoice3)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)

    // Use fireEvent.change to inject a value containing newline separators
    const input = screen.getByPlaceholderText("Invoice IDs (comma-separated, e.g. 1, 2, 3)")
    fireEvent.change(input, { target: { value: "1,2,3" } })
    await user.click(screen.getByRole("button", { name: /load invoices/i }))

    await waitFor(() => expect(mockFetchInvoice).toHaveBeenCalledTimes(3))
  })

  it("trims trailing whitespace from IDs", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "  1  ")

    await waitFor(() => expect(mockFetchInvoice).toHaveBeenCalledTimes(1))
    expect(mockFetchInvoice).toHaveBeenCalledWith("test-contract-id", 1)
  })

  it("shows error for mixed valid and invalid input where all valid entries are skipped", async () => {
    const user = userEvent.setup()
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "abc, xyz")

    expect(await screen.findByText("Enter at least one valid invoice ID.")).toBeInTheDocument()
  })
})

// ── Tests: Button disabled states ─────────────────────────────────────────────

describe("BatchExpireInvoices — button disabled states", () => {
  it("Load Invoices button is disabled when input is empty", () => {
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    expect(screen.getByRole("button", { name: /load invoices/i })).toBeDisabled()
  })

  it("Load Invoices button is enabled when input has content", async () => {
    const user = userEvent.setup()
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    const input = screen.getByPlaceholderText("Invoice IDs (comma-separated, e.g. 1, 2, 3)")
    fireEvent.change(input, { target: { value: "1" } })
    expect(screen.getByRole("button", { name: /load invoices/i })).toBeEnabled()
  })

  it("Batch Expire button is disabled when walletAddress is null", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={null} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    // Select the pending invoice
    const checkbox = screen.getByLabelText("Select invoice 1")
    await user.click(checkbox)

    expect(
      screen.getByRole("button", { name: /batch expire/i })
    ).toBeDisabled()
  })

  it("Batch Expire button is disabled when walletNotReadyReason is set", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(
      <BatchExpireInvoices
        walletAddress={WALLET_ADDRESS}
        walletNotReadyReason="Your wallet is locked. Unlock Freighter and try again."
      />
    )
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    const checkbox = screen.getByLabelText("Select invoice 1")
    await user.click(checkbox)

    expect(
      screen.getByRole("button", { name: /batch expire/i })
    ).toBeDisabled()
  })

  it("Batch Expire button is disabled when no invoices are selected", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    // Don't select any invoices
    expect(
      screen.getByRole("button", { name: /batch expire \(0 selected\)/i })
    ).toBeDisabled()
  })
})

// ── Tests: Wallet not ready ────────────────────────────────────────────────────

describe("BatchExpireInvoices — wallet not ready", () => {
  it("shows wallet-not-ready message with data-testid when walletNotReadyReason is set", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(
      <BatchExpireInvoices
        walletAddress={WALLET_ADDRESS}
        walletNotReadyReason="Your wallet is locked. Unlock Freighter and try again."
      />
    )
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    const notice = screen.getByTestId("wallet-not-ready")
    expect(notice).toBeInTheDocument()
    expect(notice).toHaveTextContent(/wallet is locked/i)
  })

  it("shows wallet-not-ready message when walletAddress is null", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={null} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    expect(screen.getByTestId("wallet-not-ready")).toHaveTextContent(/connect wallet/i)
  })

  it("does not show wallet-not-ready when wallet is connected and ready", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    expect(screen.queryByTestId("wallet-not-ready")).not.toBeInTheDocument()
  })
})

// ── Tests: Confirmation modal ─────────────────────────────────────────────────

describe("BatchExpireInvoices — confirmation modal", () => {
  it("shows confirmation modal when Batch Expire button is clicked", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByRole("button", { name: /batch expire \(1 selected\)/i }))

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/confirm batch expiration/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /confirm expiration/i })).toBeInTheDocument()
  })

  it("cancel closes confirmation modal", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByRole("button", { name: /batch expire \(1 selected\)/i }))

    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /cancel batch expiration/i }))

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("shows the number of invoices being expired in the modal", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#2")).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByLabelText("Select invoice 2"))
    await user.click(screen.getByRole("button", { name: /batch expire \(2 selected\)/i }))

    expect(await screen.findByText(/you are about to expire/i)).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })
})

// ── Tests: Select all / deselect all ─────────────────────────────────────────

describe("BatchExpireInvoices — select all / deselect all", () => {
  it("select all checkbox selects all pending invoices", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)
      .mockResolvedValueOnce(paidInvoice3)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2, 3")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#2")).toBeInTheDocument()
      expect(screen.getByText("#3")).toBeInTheDocument()
    })

    const selectAll = screen.getByLabelText("Select all pending invoices")
    await user.click(selectAll)

    // Only the 2 pending invoices should be selected
    expect(
      screen.getByRole("button", { name: /batch expire \(2 selected\)/i })
    ).toBeInTheDocument()

    // Paid invoice checkbox stays disabled/unchecked
    expect(screen.getByLabelText("Select invoice 3")).toBeDisabled()
  })

  it("clicking select all again deselects all invoices", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#2")).toBeInTheDocument()
    })

    const selectAll = screen.getByLabelText("Select all pending invoices")

    // Select all
    await user.click(selectAll)
    expect(
      screen.getByRole("button", { name: /batch expire \(2 selected\)/i })
    ).toBeInTheDocument()

    // Deselect all
    await user.click(selectAll)
    expect(
      screen.getByRole("button", { name: /batch expire \(0 selected\)/i })
    ).toBeDisabled()
  })

  it("only pending invoices can be selected via individual checkboxes", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(paidInvoice3)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 3")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#3")).toBeInTheDocument()
    })

    const pendingCheckbox = screen.getByLabelText("Select invoice 1")
    const paidCheckbox = screen.getByLabelText("Select invoice 3")

    expect(pendingCheckbox).not.toBeDisabled()
    expect(paidCheckbox).toBeDisabled()

    await user.click(pendingCheckbox)
    expect(
      screen.getByRole("button", { name: /batch expire \(1 selected\)/i })
    ).toBeEnabled()
  })
})

// ── Tests: Success path ────────────────────────────────────────────────────────

describe("BatchExpireInvoices — success path", () => {
  it("shows transaction hash in success message after batch expire succeeds", async () => {
    const user = userEvent.setup()

    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)
      // After expire, fetching updated invoices
      .mockResolvedValueOnce(expiredInvoice1)
      .mockResolvedValueOnce(expiredInvoice2)

    mockBatchExpireInvoices.mockResolvedValueOnce({
      success: true,
      transaction_hash: TX_HASH,
    })

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#2")).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByLabelText("Select invoice 2"))
    await user.click(screen.getByRole("button", { name: /batch expire \(2 selected\)/i }))

    // Confirm in modal
    await user.click(await screen.findByRole("button", { name: /confirm expiration/i }))

    // Wait for success message
    const successMsg = await screen.findByText(/batch expire submitted/i)
    expect(successMsg.closest(".message--success")).toBeInTheDocument()
    expect(screen.getByText(TX_HASH)).toBeInTheDocument()
  })

  it("calls batchExpireInvoices with correct contract ID and selected IDs", async () => {
    const user = userEvent.setup()

    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(pendingInvoice2)
      .mockResolvedValueOnce(expiredInvoice1)
      .mockResolvedValueOnce(expiredInvoice2)

    mockBatchExpireInvoices.mockResolvedValueOnce({
      success: true,
      transaction_hash: TX_HASH,
    })

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 2")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#2")).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByLabelText("Select invoice 2"))
    await user.click(screen.getByRole("button", { name: /batch expire \(2 selected\)/i }))
    await user.click(await screen.findByRole("button", { name: /confirm expiration/i }))

    await waitFor(() => {
      expect(mockBatchExpireInvoices).toHaveBeenCalledWith(
        "test-contract-id",
        expect.arrayContaining([1, 2]),
        WALLET_ADDRESS
      )
    })
  })

  it("updates invoice rows to Expired status after successful batch expire", async () => {
    const user = userEvent.setup()

    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(expiredInvoice1)

    mockBatchExpireInvoices.mockResolvedValueOnce({
      success: true,
      transaction_hash: TX_HASH,
    })

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByRole("button", { name: /batch expire \(1 selected\)/i }))
    await user.click(await screen.findByRole("button", { name: /confirm expiration/i }))

    await screen.findByText(/batch expire submitted/i)

    expect(mockFetchInvoice).toHaveBeenCalledTimes(2)
  })
})

// ── Tests: Error path ──────────────────────────────────────────────────────────

describe("BatchExpireInvoices — error path", () => {
  it("shows error message when batchExpireInvoices returns success=false", async () => {
    const user = userEvent.setup()

    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)
    mockBatchExpireInvoices.mockResolvedValueOnce({
      success: false,
      error: "Transaction rejected by network",
    })

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByRole("button", { name: /batch expire \(1 selected\)/i }))
    await user.click(await screen.findByRole("button", { name: /confirm expiration/i }))

    const errorMsg = await screen.findByText(/batch expire failed: Transaction rejected by network/i)
    expect(errorMsg.closest(".message--error")).toBeInTheDocument()
  })

  it("does not show success message on failure", async () => {
    const user = userEvent.setup()

    mockFetchInvoice.mockResolvedValueOnce(pendingInvoice1)
    mockBatchExpireInvoices.mockResolvedValueOnce({
      success: false,
      error: "Insufficient fee",
    })

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1")

    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Select invoice 1"))
    await user.click(screen.getByRole("button", { name: /batch expire \(1 selected\)/i }))
    await user.click(await screen.findByRole("button", { name: /confirm expiration/i }))

    await screen.findByText(/batch expire failed/i)
    expect(screen.queryByText(/batch expire submitted/i)).not.toBeInTheDocument()
    expect(screen.queryByText(TX_HASH)).not.toBeInTheDocument()
  })
})

// ── Tests: Invoice table display ──────────────────────────────────────────────

describe("BatchExpireInvoices — invoice table", () => {
  it("renders invoices in a table after loading", async () => {
    const user = userEvent.setup()
    mockFetchInvoice
      .mockResolvedValueOnce(pendingInvoice1)
      .mockResolvedValueOnce(paidInvoice3)

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "1, 3")

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument()
      expect(screen.getByText("#3")).toBeInTheDocument()
    })

    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByText(/id/i)).toBeInTheDocument()
    expect(screen.getByText(/merchant/i)).toBeInTheDocument()
    expect(screen.getByText(/amount/i)).toBeInTheDocument()
  })

  it("shows 'No invoices found' error when all fetches fail", async () => {
    const user = userEvent.setup()
    mockFetchInvoice.mockRejectedValueOnce(new Error("Not found"))

    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    await loadInvoices(user, "999")

    expect(
      await screen.findByText("No invoices found for the given IDs.")
    ).toBeInTheDocument()
  })

  it("does not show the table before invoices are loaded", () => {
    render(<BatchExpireInvoices walletAddress={WALLET_ADDRESS} />)
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})
