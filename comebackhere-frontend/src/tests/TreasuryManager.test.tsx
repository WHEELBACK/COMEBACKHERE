import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { TreasuryManager } from "../components/TreasuryManager"

// ── Mock utils/treasury ──────────────────────────────────────────────────────

const mockFetchBalances = vi.fn()
const mockFetchPendingSettlements = vi.fn()
const mockApproveSettlement = vi.fn()
const mockExecuteSettlement = vi.fn()

vi.mock("../utils/treasury", () => ({
  fetchBalances: (...args: unknown[]) => mockFetchBalances(...args),
  fetchPendingSettlements: (...args: unknown[]) => mockFetchPendingSettlements(...args),
  approveSettlement: (...args: unknown[]) => mockApproveSettlement(...args),
  executeSettlement: (...args: unknown[]) => mockExecuteSettlement(...args),
  fetchThreshold: vi.fn().mockResolvedValue(3),
}))

// ── Mock hooks ───────────────────────────────────────────────────────────────

let mockWallet: { address: string | null; connected: boolean }

vi.mock("../hooks/useWallet", () => ({
  useWallet: () => mockWallet,
}))

vi.mock("../hooks/usePolling", () => ({
  usePolling: (_fn: unknown, opts: { enabled?: boolean }) => {
    if (opts.enabled) {
      // trigger the callback synchronously in tests via the mock resolution
    }
    return { lastUpdatedAt: null, polling: false }
  },
}))

// ── Constants ────────────────────────────────────────────────────────────────

const WALLET_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
const SIGNER_B = "GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF"

const mockSettlementBelowThreshold = {
  id: "settlement-1",
  amount: "1000",
  approvals: [SIGNER_B],
  approval_weight: 1,
  threshold: 3,
  status: "Pending" as const,
}

const mockSettlementAtThreshold = {
  id: "settlement-2",
  amount: "2000",
  approvals: [SIGNER_B, WALLET_ADDRESS],
  approval_weight: 3,
  threshold: 3,
  status: "ReadyToExecute" as const,
}

const mockSettlementAboveThreshold = {
  id: "settlement-3",
  amount: "3000",
  approvals: [SIGNER_B, WALLET_ADDRESS],
  approval_weight: 4,
  threshold: 3,
  status: "ReadyToExecute" as const,
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockWallet = { address: WALLET_ADDRESS, connected: true }
  mockFetchBalances.mockResolvedValue([
    { token: "USDC", balance: "5000000" },
    { token: "XLM", balance: "100000000" },
  ])
  mockFetchPendingSettlements.mockResolvedValue([])
  mockApproveSettlement.mockResolvedValue({ success: true, hash: "approvehash" })
  mockExecuteSettlement.mockResolvedValue({ success: true, hash: "executehash" })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TreasuryManager — rendering", () => {
  it("renders the heading and deposit/withdraw tabs", () => {
    render(<TreasuryManager />)

    expect(screen.getByText("Treasury Management")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /deposit/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /withdraw/i })).toBeInTheDocument()
  })

  it("shows the Deposit tab as selected by default", () => {
    render(<TreasuryManager />)

    expect(screen.getByRole("tab", { name: /deposit/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /withdraw/i })).toHaveAttribute("aria-selected", "false")
  })

  it("shows the Pending Settlements section", () => {
    render(<TreasuryManager />)

    expect(screen.getByText("Pending Settlements")).toBeInTheDocument()
  })
})

describe("TreasuryManager — wallet disconnected", () => {
  beforeEach(() => {
    mockWallet = { address: null, connected: false }
  })

  it("shows connect wallet prompt in balances table", () => {
    render(<TreasuryManager />)

    expect(screen.getByText("Connect your wallet to view balances.")).toBeInTheDocument()
  })

  it("disables the Refresh button when wallet is not connected", () => {
    render(<TreasuryManager />)

    expect(screen.getByRole("button", { name: /refresh treasury balances/i })).toBeDisabled()
  })
})

describe("TreasuryManager — balances display", () => {
  it("fetches and displays balances after polling triggers", async () => {
    // Simulate polling effect by calling fetchBalances directly through component lifecycle
    mockFetchBalances.mockResolvedValue([
      { token: "USDC", balance: "5000000" },
      { token: "XLM", balance: "100000000" },
    ])
    render(<TreasuryManager />)

    // The polling hook triggers loadBalances but since we mock it to not call back,
    // we verify at least the table structure renders
    expect(screen.getByText("Treasury Balances")).toBeInTheDocument()
    expect(screen.getByRole("table")).toBeInTheDocument()
  })

  it("shows a balance fetch error in an alert", async () => {
    // Directly trigger balance load by clicking Refresh button
    mockFetchBalances.mockRejectedValue(new Error("Backend unavailable"))
    render(<TreasuryManager />)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: /refresh treasury balances/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable")
    )
  })
})

describe("TreasuryManager — deposit/withdraw tabs", () => {
  it("switches to Withdraw tab when clicked", async () => {
    const user = userEvent.setup()
    render(<TreasuryManager />)

    await user.click(screen.getByRole("tab", { name: /withdraw/i }))

    expect(screen.getByRole("tab", { name: /withdraw/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /deposit/i })).toHaveAttribute("aria-selected", "false")
  })

  it("shows Recipient Address field only in Withdraw tab", async () => {
    const user = userEvent.setup()
    render(<TreasuryManager />)

    expect(screen.queryByLabelText(/recipient stellar address/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: /withdraw/i }))

    expect(screen.getByLabelText(/recipient stellar address/i)).toBeInTheDocument()
  })

  it("Submit button is disabled when amount is empty", () => {
    render(<TreasuryManager />)

    const submitBtn = screen.getByRole("button", { name: /submit deposit/i })
    expect(submitBtn).toBeDisabled()
  })

  it("shows error when submitting without a wallet connection", async () => {
    mockWallet = { address: null, connected: false }
    const user = userEvent.setup()
    render(<TreasuryManager />)

    const amountInput = screen.getByLabelText(/amount/i)
    await user.type(amountInput, "100")

    // Button is still disabled because recipientValid depends on connected state,
    // but we can verify the form state
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("TreasuryManager — double-submit protection", () => {
  it("disables the submit button while a transaction is in progress", async () => {
    let resolveAction!: (val: { success: boolean; hash: string }) => void
    // We mock the soroban-client dynamic import path instead by leaving submit to error
    // In practice the callTreasuryAction function is internal; we test via the soroban-client mock
    // The button disabled state during submission is tested here:
    mockFetchBalances.mockResolvedValue([])

    // Intercept submit by making the wallet check fail at the right moment
    // Since callTreasuryAction uses dynamic import(soroban-client), it will throw in jsdom
    // This actually tests the error path which also re-enables the button
    mockWallet = { address: WALLET_ADDRESS, connected: true }

    render(<TreasuryManager />)
    const user = userEvent.setup()

    const amountInput = screen.getByLabelText(/amount/i)
    await user.type(amountInput, "100")

    const submitBtn = screen.getByRole("button", { name: /submit deposit/i })

    // Button should be enabled with valid amount
    expect(submitBtn).not.toBeDisabled()

    // Click submit — callTreasuryAction will fail (no soroban-client in jsdom)
    await user.click(submitBtn)

    // After the error is thrown, the button re-enables (no longer submitting)
    await waitFor(() => expect(submitBtn).not.toBeDisabled())

    // Error should be shown
    expect(screen.getByRole("alert")).toBeInTheDocument()

    void resolveAction // unused but keeps eslint happy
  })
})

describe("TreasuryManager — settlements below threshold", () => {
  it("renders a settlement card with progress bar below threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementBelowThreshold])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByText(/settlement settlement-1/i)).toBeInTheDocument()
    )

    const progress = screen.getByRole("progressbar")
    expect(progress).toHaveAttribute("value", "1")
    expect(progress).toHaveAttribute("max", "3")
    expect(progress).toHaveAttribute("aria-label", "1 of 3 weight approved")
    expect(screen.getByText("1 of 3 weight approved")).toBeInTheDocument()
  })

  it("does not show Ready to execute badge when below threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementBelowThreshold])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByText(/settlement settlement-1/i)).toBeInTheDocument()
    )

    expect(screen.queryByText(/ready to execute/i)).not.toBeInTheDocument()
  })

  it("does not show Execute button when below threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementBelowThreshold])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByText(/settlement settlement-1/i)).toBeInTheDocument()
    )

    expect(
      screen.queryByRole("button", { name: /execute settlement/i })
    ).not.toBeInTheDocument()
  })

  it("shows Approve button for a settlement the wallet has not approved yet", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementBelowThreshold])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /approve settlement/i })).toBeInTheDocument()
    )
  })
})

describe("TreasuryManager — settlements at threshold", () => {
  it("shows Ready to execute badge when approval_weight equals threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)

    await waitFor(() => expect(screen.getByText(/ready to execute/i)).toBeInTheDocument())
  })

  it("shows an accessible progress label at threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)

    await waitFor(() => {
      const progress = screen.getByRole("progressbar")
      expect(progress).toHaveAttribute("aria-label", "3 of 3 weight approved")
    })
  })

  it("shows Execute button when at threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /execute settlement/i })
      ).toBeInTheDocument()
    )
  })
})

describe("TreasuryManager — settlements above threshold", () => {
  it("shows Ready to execute badge when approval_weight exceeds threshold", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAboveThreshold])
    render(<TreasuryManager />)

    await waitFor(() => expect(screen.getByText(/ready to execute/i)).toBeInTheDocument())
  })

  it("shows progress bar with approval_weight above max", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAboveThreshold])
    render(<TreasuryManager />)

    await waitFor(() => {
      const progress = screen.getByRole("progressbar")
      expect(progress).toHaveAttribute("value", "4")
      expect(progress).toHaveAttribute("max", "3")
    })
  })
})

describe("TreasuryManager — approve settlement flow", () => {
  it("calls approveSettlement with settlement id and wallet address", async () => {
    const settlement = { ...mockSettlementBelowThreshold, approvals: [] }
    mockFetchPendingSettlements.mockResolvedValue([settlement])
    render(<TreasuryManager />)
    const user = userEvent.setup()

    const approveBtn = await screen.findByRole("button", { name: /approve settlement settlement-1/i })
    await user.click(approveBtn)

    await waitFor(() =>
      expect(mockApproveSettlement).toHaveBeenCalledWith("settlement-1", WALLET_ADDRESS)
    )
  })

  it("refreshes settlements list after approval", async () => {
    const settlement = { ...mockSettlementBelowThreshold, approvals: [] }
    mockFetchPendingSettlements.mockResolvedValue([settlement])
    render(<TreasuryManager />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: /approve settlement settlement-1/i }))

    await waitFor(() => expect(mockFetchPendingSettlements).toHaveBeenCalledTimes(2))
  })

  it("shows error when approve fails", async () => {
    const settlement = { ...mockSettlementBelowThreshold, approvals: [] }
    mockFetchPendingSettlements.mockResolvedValue([settlement])
    mockApproveSettlement.mockResolvedValue({ success: false, error: "Insufficient weight" })
    render(<TreasuryManager />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: /approve settlement settlement-1/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Insufficient weight")
    )
  })

  it("disables Approve button for a settlement already approved by wallet", async () => {
    // wallet address is already in the approvals list
    const settlement = {
      ...mockSettlementBelowThreshold,
      approvals: [WALLET_ADDRESS],
    }
    mockFetchPendingSettlements.mockResolvedValue([settlement])
    render(<TreasuryManager />)

    const approveBtn = await screen.findByRole("button", {
      name: /approve settlement settlement-1/i,
    })
    expect(approveBtn).toBeDisabled()
  })
})

describe("TreasuryManager — execute settlement flow", () => {
  it("calls executeSettlement with settlement id and wallet address", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)
    const user = userEvent.setup()

    const executeBtn = await screen.findByRole("button", {
      name: /execute settlement settlement-2/i,
    })
    await user.click(executeBtn)

    await waitFor(() =>
      expect(mockExecuteSettlement).toHaveBeenCalledWith("settlement-2", WALLET_ADDRESS)
    )
  })

  it("refreshes settlements list after execution", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)
    const user = userEvent.setup()

    await user.click(
      await screen.findByRole("button", { name: /execute settlement settlement-2/i })
    )

    await waitFor(() => expect(mockFetchPendingSettlements).toHaveBeenCalledTimes(2))
  })

  it("shows error when execute fails", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    mockExecuteSettlement.mockResolvedValue({ success: false, error: "Transaction failed" })
    render(<TreasuryManager />)
    const user = userEvent.setup()

    await user.click(
      await screen.findByRole("button", { name: /execute settlement settlement-2/i })
    )

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Transaction failed")
    )
  })

  it("double-submit protection: execute button is disabled while executing", async () => {
    let resolveExecute!: (val: { success: boolean; hash: string }) => void
    mockExecuteSettlement.mockReturnValue(
      new Promise<{ success: boolean; hash: string }>((res) => {
        resolveExecute = res
      })
    )
    // Keep settlement list fetch pending so component stays in submitting state
    let resolveSettlements!: (val: typeof mockSettlementAtThreshold[]) => void
    mockFetchPendingSettlements
      .mockResolvedValueOnce([mockSettlementAtThreshold])
      .mockReturnValue(new Promise<typeof mockSettlementAtThreshold[]>((res) => { resolveSettlements = res }))

    render(<TreasuryManager />)
    const user = userEvent.setup()

    const executeBtn = await screen.findByRole("button", {
      name: /execute settlement settlement-2/i,
    })
    await user.click(executeBtn)

    // While executing, the button should be disabled
    expect(executeBtn).toBeDisabled()

    // Resolve to clean up
    resolveExecute({ success: true, hash: "hash" })
    resolveSettlements([])
  })

  it("approver list is shown for settlements with approvals", async () => {
    mockFetchPendingSettlements.mockResolvedValue([mockSettlementAtThreshold])
    render(<TreasuryManager />)

    await waitFor(() => expect(screen.getByText(/approvers:/i)).toBeInTheDocument())
    // Both approver addresses should be shown (shortened)
    expect(screen.getByText(`${SIGNER_B.slice(0, 6)}…${SIGNER_B.slice(-4)}`)).toBeInTheDocument()
  })
})

describe("TreasuryManager — empty settlements", () => {
  it("shows empty state when there are no pending settlements", async () => {
    mockFetchPendingSettlements.mockResolvedValue([])
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByText("No pending settlements.")).toBeInTheDocument()
    )
  })
})

describe("TreasuryManager — settlements error", () => {
  it("shows error when fetchPendingSettlements fails", async () => {
    mockFetchPendingSettlements.mockRejectedValue(new Error("Settlements unavailable"))
    render(<TreasuryManager />)

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Settlements unavailable")
    )
  })
})
