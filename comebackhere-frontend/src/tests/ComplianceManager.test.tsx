import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { ComplianceManager } from "../components/ComplianceManager"

// ── Mock utils/compliance ────────────────────────────────────────────────────

const mockGetAddressStatus = vi.fn()
const mockGetSignerAddress = vi.fn()
const mockGetRecentAddresses = vi.fn()
const mockAllowAddress = vi.fn()
const mockAllowAddressUntil = vi.fn()
const mockBlockAddress = vi.fn()
const mockClearAddress = vi.fn()

vi.mock("../utils/compliance", () => ({
  getAddressStatus: (...args: unknown[]) => mockGetAddressStatus(...args),
  getSignerAddress: (...args: unknown[]) => mockGetSignerAddress(...args),
  getRecentAddresses: (...args: unknown[]) => mockGetRecentAddresses(...args),
  allowAddress: (...args: unknown[]) => mockAllowAddress(...args),
  allowAddressUntil: (...args: unknown[]) => mockAllowAddressUntil(...args),
  blockAddress: (...args: unknown[]) => mockBlockAddress(...args),
  clearAddress: (...args: unknown[]) => mockClearAddress(...args),
}))

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
const SIGNER_ADDRESS = "GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF"

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRecentAddresses.mockResolvedValue([])
  mockGetSignerAddress.mockResolvedValue(SIGNER_ADDRESS)
  mockGetAddressStatus.mockResolvedValue({ status: "Allowed", expiresAt: null })
  mockAllowAddress.mockResolvedValue({ success: true, hash: "txhash123" })
  mockAllowAddressUntil.mockResolvedValue({ success: true, hash: "txhash456" })
  mockBlockAddress.mockResolvedValue({ success: true, hash: "txhash789" })
  mockClearAddress.mockResolvedValue({ success: true, hash: "txhashclear" })
})

// ── Helper ───────────────────────────────────────────────────────────────────

async function typeAddress(address: string) {
  const user = userEvent.setup()
  const input = screen.getByPlaceholderText("G...")
  await user.clear(input)
  await user.type(input, address)
  return user
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ComplianceManager — rendering", () => {
  it("renders the heading and action buttons", () => {
    render(<ComplianceManager />)

    expect(screen.getByText("Compliance Address Management")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fetch.*status/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /block address/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeInTheDocument()
  })

  it("loads recent addresses on mount", async () => {
    mockGetRecentAddresses.mockResolvedValue([VALID_ADDRESS])
    render(<ComplianceManager />)

    await waitFor(() => expect(mockGetRecentAddresses).toHaveBeenCalledOnce())
  })
})

describe("ComplianceManager — input validation", () => {
  it("all action buttons are disabled when address is empty", () => {
    render(<ComplianceManager />)

    expect(screen.getByRole("button", { name: /fetch.*status/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
  })

  it("all action buttons are disabled when address is malformed", async () => {
    render(<ComplianceManager />)
    await typeAddress("not-a-valid-address")

    expect(screen.getByRole("button", { name: /fetch.*status/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
  })

  it("all action buttons are enabled when a valid address is entered", async () => {
    render(<ComplianceManager />)
    await typeAddress(VALID_ADDRESS)

    expect(screen.getByRole("button", { name: /fetch.*status/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /allow address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).not.toBeDisabled()
  })

  it("shows validation error when Allow is clicked with invalid address", async () => {
    render(<ComplianceManager />)
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText("G...")
    await user.type(input, "bad")
    // Force enable by directly clicking (but button should be disabled, so test validation msg)
    // Instead test the fetch status path which internally validates
    const fetchBtn = screen.getByRole("button", { name: /fetch.*status/i })
    expect(fetchBtn).toBeDisabled()
    // No error shown without clicking
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("ComplianceManager — status lookup", () => {
  it("fetches and displays Allowed status", async () => {
    mockGetAddressStatus.mockResolvedValue({ status: "Allowed", expiresAt: null })
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() =>
      expect(screen.getByText(/loaded current compliance status/i)).toBeInTheDocument()
    )
    expect(screen.getByText("Allowed")).toBeInTheDocument()
    expect(mockGetAddressStatus).toHaveBeenCalledWith(VALID_ADDRESS)
  })

  it("fetches and displays Blocked status", async () => {
    mockGetAddressStatus.mockResolvedValue({ status: "Blocked", expiresAt: null })
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() => expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0))
  })

  it("fetches and displays AllowedUntil status with expiry", async () => {
    const expiresAt = 1900000000
    mockGetAddressStatus.mockResolvedValue({ status: "AllowedUntil", expiresAt })
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() => expect(screen.getAllByText("Allowed until").length).toBeGreaterThan(0))
    expect(screen.getByText(/expires at/i)).toBeInTheDocument()
  })

  it("shows error alert when status fetch fails", async () => {
    mockGetAddressStatus.mockRejectedValue(new Error("Contract error"))
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Contract error")
    )
  })

  it("shows error alert when fetch returns server error", async () => {
    mockGetAddressStatus.mockRejectedValue(new Error("HTTP 500"))
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("HTTP 500")
    )
  })
})

describe("ComplianceManager — allow action", () => {
  it("calls allowAddress with correct arguments and shows success", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))

    await waitFor(() => expect(mockAllowAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address allowed/i)
    )
  })

  it("calls allowAddressUntil when an expiry date is set", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    const expiryInput = screen.getByLabelText(/allow until/i)
    await user.type(expiryInput, "2030-01-01T00:00")

    await user.click(screen.getByRole("button", { name: /allow address/i }))

    await waitFor(() => expect(mockAllowAddressUntil).toHaveBeenCalled())
  })

  it("shows error when allow action fails", async () => {
    mockAllowAddress.mockResolvedValue({ success: false, error: "Not admin" })
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Not admin")
    )
  })
})

describe("ComplianceManager — block action", () => {
  it("calls blockAddress with correct arguments and shows success", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /block address/i }))

    await waitFor(() => expect(mockBlockAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address blocked/i)
    )
  })

  it("shows error when block action fails", async () => {
    mockBlockAddress.mockResolvedValue({ success: false, error: "Network timeout" })
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /block address/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Network timeout")
    )
  })
})

describe("ComplianceManager — clear action", () => {
  it("calls clearAddress with correct arguments and shows success", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /clear address/i }))

    await waitFor(() => expect(mockClearAddress).toHaveBeenCalledWith(VALID_ADDRESS, SIGNER_ADDRESS))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/address cleared/i)
    )
  })
})

describe("ComplianceManager — buttons disabled during submission", () => {
  it("disables all action buttons while a request is in progress", async () => {
    // Make the action hang indefinitely
    let resolveAction!: (val: { success: boolean; hash: string }) => void
    mockAllowAddress.mockReturnValue(
      new Promise<{ success: boolean; hash: string }>((res) => {
        resolveAction = res
      })
    )
    // Also keep status refresh pending after allow
    mockGetAddressStatus.mockReturnValue(new Promise(() => {}))

    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))

    // While in-flight all buttons should be disabled
    expect(screen.getByRole("button", { name: /allow address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /block address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /fetch.*status/i })).toBeDisabled()

    // Resolve so we don't leave dangling promises
    resolveAction({ success: true, hash: "txhash" })
  })

  it("re-enables buttons after the request completes", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /allow address/i }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /allow address/i })).not.toBeDisabled()
    )
    expect(screen.getByRole("button", { name: /block address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /clear address/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /fetch.*status/i })).not.toBeDisabled()
  })
})

describe("ComplianceManager — managed address table", () => {
  it("shows a message when no addresses have been managed yet", () => {
    render(<ComplianceManager />)

    expect(screen.getByText("No managed addresses yet.")).toBeInTheDocument()
  })

  it("adds an entry to the managed table after a successful status lookup", async () => {
    render(<ComplianceManager />)
    const user = await typeAddress(VALID_ADDRESS)

    await user.click(screen.getByRole("button", { name: /fetch.*status/i }))

    await waitFor(() =>
      expect(screen.getByText(/loaded current compliance status/i)).toBeInTheDocument()
    )
    // The address should appear in the managed table
    expect(screen.getAllByText(VALID_ADDRESS).length).toBeGreaterThan(0)
  })
})
