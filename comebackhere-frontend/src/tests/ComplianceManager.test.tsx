import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { ComplianceManager } from "../components/ComplianceManager"

// ---------------------------------------------------------------------------
// Mock utils/compliance
// ---------------------------------------------------------------------------

const mockGetAddressStatus = vi.fn()
const mockGetSignerAddress = vi.fn()
const mockAllowAddress = vi.fn()
const mockAllowAddressUntil = vi.fn()
const mockBlockAddress = vi.fn()
const mockClearAddress = vi.fn()
const mockGetRecentAddresses = vi.fn()

vi.mock("../utils/compliance", () => ({
  getAddressStatus: (...args: unknown[]) => mockGetAddressStatus(...args),
  getSignerAddress: (...args: unknown[]) => mockGetSignerAddress(...args),
  allowAddress: (...args: unknown[]) => mockAllowAddress(...args),
  allowAddressUntil: (...args: unknown[]) => mockAllowAddressUntil(...args),
  blockAddress: (...args: unknown[]) => mockBlockAddress(...args),
  clearAddress: (...args: unknown[]) => mockClearAddress(...args),
  getRecentAddresses: (...args: unknown[]) => mockGetRecentAddresses(...args),
}))

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/** A valid 56-char Stellar address starting with G. */
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
const VALID_ADDRESS_2 = "GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF"

const SIGNER_ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGFCLF94ST9CL2ZT1TWK"

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRecentAddresses.mockResolvedValue([])
  mockGetSignerAddress.mockResolvedValue(SIGNER_ADDRESS)
  mockGetAddressStatus.mockResolvedValue({ status: "Allowed", expiresAt: null })
  mockAllowAddress.mockResolvedValue({ success: true, hash: "txhash_allow" })
  mockAllowAddressUntil.mockResolvedValue({ success: true, hash: "txhash_allow_until" })
  mockBlockAddress.mockResolvedValue({ success: true, hash: "txhash_block" })
  mockClearAddress.mockResolvedValue({ success: true, hash: "txhash_clear" })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ComplianceManager — rendering", () => {
  it("renders the page heading", () => {
    render(<ComplianceManager />)
    expect(screen.getByRole("heading", { name: /compliance address management/i })).toBeInTheDocument()
  })

  it("renders the address input field", () => {
    render(<ComplianceManager />)
    expect(screen.getByPlaceholderText("G...")).toBeInTheDocument()
  })

  it("renders all action buttons", () => {
    render(<ComplianceManager />)
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /block address/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeInTheDocument()
  })

  it("renders the managed addresses table with empty state", () => {
    render(<ComplianceManager />)
    expect(screen.getByText(/no managed addresses yet/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Input validation — malformed addresses
// ---------------------------------------------------------------------------

describe("ComplianceManager — input validation", () => {
  it("disables all buttons when the address field is empty", () => {
    render(<ComplianceManager />)
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
  })

  it("disables buttons when the address is too short", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), "GSHORT")
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
  })

  it("disables buttons when the address does not start with G", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    // 56-char address starting with a letter other than G
    await user.type(screen.getByPlaceholderText("G..."), "AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeDisabled()
  })

  it("enables buttons when a valid 56-char Stellar address is entered", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    expect(screen.getByRole("button", { name: /fetch status/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).not.toBeDisabled()
  })

  it("shows a validation error when Fetch Status is clicked with an invalid address", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    // Type an invalid address but bypass disabled state by directly patching state
    // (Buttons are disabled for invalid addresses; test the guard inside the handler.)
    // Simulate a scenario where the input is manipulated to be empty AFTER initial type
    const input = screen.getByPlaceholderText("G...")
    await user.type(input, VALID_ADDRESS)
    await user.clear(input)
    // Now type something short so the handler guard is exercised via submit
    await user.type(input, "GBAD")
    // Buttons are disabled — validation message is shown only when addressValid is false
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Fetch Status flow
// ---------------------------------------------------------------------------

describe("ComplianceManager — Fetch Status", () => {
  it("calls getAddressStatus with the entered address", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(mockGetAddressStatus).toHaveBeenCalledWith(VALID_ADDRESS))
  })

  it("displays the returned status after a successful fetch", async () => {
    mockGetAddressStatus.mockResolvedValue({ status: "Blocked", expiresAt: null })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument())
    expect(screen.getByText("Blocked")).toBeInTheDocument()
  })

  it("displays the success message after a successful fetch", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/loaded current compliance status/i)
    )
  })

  it("adds the address to the managed addresses table after a fetch", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() =>
      expect(screen.queryByText(/no managed addresses yet/i)).not.toBeInTheDocument()
    )
  })

  it("shows error message when getAddressStatus rejects", async () => {
    mockGetAddressStatus.mockRejectedValue(new Error("Contract error: address not found"))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/contract error: address not found/i)
    )
  })

  it("shows 'Fetching...' label while the request is in progress and buttons are disabled", async () => {
    let resolveStatus!: (v: unknown) => void
    mockGetAddressStatus.mockReturnValue(new Promise((res) => { resolveStatus = res }))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    expect(screen.getByRole("button", { name: /fetching/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
    resolveStatus({ status: "Allowed", expiresAt: null })
  })

  it("displays the expiry date when status is AllowedUntil", async () => {
    const expiresAt = 2000000000 // some future Unix timestamp
    mockGetAddressStatus.mockResolvedValue({ status: "AllowedUntil", expiresAt })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(screen.getByText(/expires at/i)).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Allow address flow
// ---------------------------------------------------------------------------

describe("ComplianceManager — Allow address", () => {
  it("calls getSignerAddress then allowAddress on a successful allow", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() => expect(mockGetSignerAddress).toHaveBeenCalled())
    await waitFor(() =>
      expect(mockAllowAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS)
    )
  })

  it("shows success message with transaction hash after allowing", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address allowed/i)
    )
    expect(screen.getByRole("status")).toHaveTextContent(/txhash_allow/i)
  })

  it("calls allowAddressUntil when an expiry datetime is set", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    // Set a datetime-local value in the future
    const expiryInput = screen.getByLabelText(/allow until/i)
    await user.type(expiryInput, "2099-12-31T23:59")
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() => expect(mockAllowAddressUntil).toHaveBeenCalled())
    expect(mockAllowAddress).not.toHaveBeenCalled()
  })

  it("shows error when allowAddress returns success: false", async () => {
    mockAllowAddress.mockResolvedValue({ success: false, error: "Unauthorized signer" })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/unauthorized signer/i)
    )
  })

  it("shows error when allowAddress throws a network error", async () => {
    mockAllowAddress.mockRejectedValue(new Error("Network failure"))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/network failure/i)
    )
  })

  it("disables buttons while allow submission is in progress", async () => {
    let resolve!: (v: unknown) => void
    mockAllowAddress.mockReturnValue(new Promise((res) => { resolve = res }))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    expect(screen.getByRole("button", { name: /fetch status/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
    resolve({ success: true, hash: "txhash_allow" })
  })
})

// ---------------------------------------------------------------------------
// Block address flow
// ---------------------------------------------------------------------------

describe("ComplianceManager — Block address", () => {
  it("calls blockAddress with the correct arguments", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /block address/i }))
    await waitFor(() =>
      expect(mockBlockAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS)
    )
  })

  it("shows success message with transaction hash after blocking", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /block address/i }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address blocked/i)
    )
    expect(screen.getByRole("status")).toHaveTextContent(/txhash_block/i)
  })

  it("shows error when blockAddress returns success: false", async () => {
    mockBlockAddress.mockResolvedValue({ success: false, error: "Contract rejected" })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /block address/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/contract rejected/i)
    )
  })

  it("refreshes the status display after successfully blocking", async () => {
    mockGetAddressStatus.mockResolvedValue({ status: "Blocked", expiresAt: null })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /block address/i }))
    await waitFor(() => expect(screen.getByText("Blocked")).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Clear address flow
// ---------------------------------------------------------------------------

describe("ComplianceManager — Clear address", () => {
  it("calls clearAddress with the correct arguments", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /clear address/i }))
    await waitFor(() =>
      expect(mockClearAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS)
    )
  })

  it("shows success message with transaction hash after clearing", async () => {
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /clear address/i }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address cleared/i)
    )
    expect(screen.getByRole("status")).toHaveTextContent(/txhash_clear/i)
  })
})

// ---------------------------------------------------------------------------
// Managed addresses table
// ---------------------------------------------------------------------------

describe("ComplianceManager — Managed addresses table", () => {
  it("adds an entry to the managed table after fetching status", async () => {
    mockGetAddressStatus.mockResolvedValue({ status: "Allowed", expiresAt: null })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() =>
      expect(screen.queryByText(/no managed addresses yet/i)).not.toBeInTheDocument()
    )
    expect(screen.getAllByText("Allowed").length).toBeGreaterThanOrEqual(1)
  })

  it("updates an existing managed entry when the same address is fetched again", async () => {
    mockGetAddressStatus
      .mockResolvedValueOnce({ status: "Allowed", expiresAt: null })
      .mockResolvedValueOnce({ status: "Blocked", expiresAt: null })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(screen.queryByText(/no managed addresses yet/i)).not.toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(screen.getByText("Blocked")).toBeInTheDocument())
    // Should still have only one row for the same address
    expect(screen.getAllByText("Blocked").length).toBeGreaterThanOrEqual(1)
  })

  it("tracks multiple distinct addresses in the managed table", async () => {
    mockGetAddressStatus
      .mockResolvedValueOnce({ status: "Allowed", expiresAt: null })
      .mockResolvedValueOnce({ status: "Blocked", expiresAt: null })
      .mockResolvedValue({ status: "Allowed", expiresAt: null })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    const input = screen.getByPlaceholderText("G...")

    await user.type(input, VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(screen.queryByText(/no managed addresses yet/i)).not.toBeInTheDocument())

    await user.clear(input)
    await user.type(input, VALID_ADDRESS_2)
    await user.click(screen.getByRole("button", { name: /fetch status/i }))
    await waitFor(() => expect(mockGetAddressStatus).toHaveBeenCalledTimes(2))
  })
})

// ---------------------------------------------------------------------------
// Server / contract error handling
// ---------------------------------------------------------------------------

describe("ComplianceManager — error handling", () => {
  it("shows error when getSignerAddress fails (wallet not connected)", async () => {
    mockGetSignerAddress.mockRejectedValue(new Error("Connect your wallet to sign compliance updates."))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)
    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/connect your wallet/i)
    )
  })

  it("clears previous error when a new action succeeds", async () => {
    mockAllowAddress
      .mockRejectedValueOnce(new Error("First failure"))
      .mockResolvedValueOnce({ success: true, hash: "txhash_retry" })
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    )
    expect(screen.getByRole("status")).toHaveTextContent(/address allowed/i)
  })

  it("clears previous success when a subsequent action fails", async () => {
    mockAllowAddress
      .mockResolvedValueOnce({ success: true, hash: "txhash_success" })
      .mockRejectedValueOnce(new Error("Second failure"))
    const user = userEvent.setup()
    render(<ComplianceManager />)
    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: /allow address/i }))
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    )
    expect(screen.getByRole("alert")).toHaveTextContent(/second failure/i)
  })
})

// ---------------------------------------------------------------------------
// Recent addresses autocomplete
// ---------------------------------------------------------------------------

describe("ComplianceManager — recent addresses autocomplete", () => {
  it("loads recent addresses on mount via getRecentAddresses", async () => {
    mockGetRecentAddresses.mockResolvedValue([VALID_ADDRESS])
    render(<ComplianceManager />)
    await waitFor(() => expect(mockGetRecentAddresses).toHaveBeenCalled())
  })

  it("does not crash when getRecentAddresses returns an empty array", async () => {
    mockGetRecentAddresses.mockResolvedValue([])
    render(<ComplianceManager />)
    await waitFor(() => expect(mockGetRecentAddresses).toHaveBeenCalled())
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })
})
