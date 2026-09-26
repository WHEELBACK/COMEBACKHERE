import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import SignerManagement from "./SignerManagement"
import type { SignerInfo } from "../../hooks/useSigners"

// ---------------------------------------------------------------------------
// Mock hooks/useSigners
// ---------------------------------------------------------------------------

const mockUseSigners = vi.fn()

vi.mock("../../hooks/useSigners", () => ({
  useSigners: () => mockUseSigners(),
}))

// ---------------------------------------------------------------------------
// Mock hooks/useWallet — admin is always connected by default
// ---------------------------------------------------------------------------

const mockUseWallet = vi.fn()

vi.mock("../../hooks/useWallet", () => ({
  useWallet: () => mockUseWallet(),
}))

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
const ADDR_B = "GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSigners(addresses: string[]): SignerInfo[] {
  return addresses.map((address, i) => ({ address, weight: i + 1 }))
}

type UseSignersReturn = {
  signers: SignerInfo[]
  loading: boolean
  error: string | null
  addSigner: ReturnType<typeof vi.fn>
  removeSigner: ReturnType<typeof vi.fn>
  rotateSigners: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
}

function mockSigners(
  signers: SignerInfo[],
  overrides: Partial<UseSignersReturn> = {},
): void {
  mockUseSigners.mockReturnValue({
    signers,
    loading: false,
    error: null,
    addSigner: vi.fn(),
    removeSigner: vi.fn(),
    rotateSigners: vi.fn(),
    refresh: vi.fn(),
    invalidate: vi.fn(),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockUseWallet.mockReturnValue({
    address: ADDR_A,
    connected: true,
    connecting: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  mockSigners([])
})

// ---------------------------------------------------------------------------
// Admin-only visibility
// ---------------------------------------------------------------------------

describe("SignerManagement — admin-only visibility", () => {
  it("renders the component when wallet is connected", () => {
    render(<SignerManagement />)
    expect(screen.getByRole("heading", { name: /signer management/i })).toBeInTheDocument()
  })

  it("shows a connect wallet prompt when not connected", () => {
    mockUseWallet.mockReturnValue({
      address: null,
      connected: false,
      connecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
    })
    render(<SignerManagement />)
    expect(screen.getByText(/connect your wallet to manage signers/i)).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: /signer management/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

describe("SignerManagement — loading and error states", () => {
  it("shows loading indicator while signers are being fetched", () => {
    mockSigners([], { loading: true })
    render(<SignerManagement />)
    expect(screen.getByText(/loading signers/i)).toBeInTheDocument()
  })

  it("shows error message when fetch fails", () => {
    mockSigners([], { error: "HTTP 500" })
    render(<SignerManagement />)
    expect(screen.getByText(/error: http 500/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Rendering signer list
// ---------------------------------------------------------------------------

describe("SignerManagement — signer list rendering", () => {
  it("shows empty state when no signers are configured", () => {
    mockSigners([])
    render(<SignerManagement />)
    expect(screen.getByText(/no signers configured/i)).toBeInTheDocument()
  })

  it("renders a row for each signer", () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)
    expect(screen.getAllByRole("row").length).toBeGreaterThanOrEqual(2)
  })

  it("renders an identicon for each signer", () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)
    expect(screen.getAllByRole("img", { name: /identicon for/i })).toHaveLength(2)
  })

  it("renders no identicons when signer list is empty", () => {
    mockSigners([])
    render(<SignerManagement />)
    expect(screen.queryAllByRole("img", { name: /identicon for/i })).toHaveLength(0)
  })

  it("each identicon aria-label contains a shortened address", () => {
    mockSigners(makeSigners([ADDR_A]))
    render(<SignerManagement />)
    expect(
      screen.getByRole("img", { name: /identicon for gaazi4/i }),
    ).toBeInTheDocument()
  })

  it("renders the weight badge for each signer", () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("renders a Remove button for each signer", () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)
    expect(screen.getAllByRole("button", { name: /remove signer/i })).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Identicon determinism
// ---------------------------------------------------------------------------

describe("SignerManagement — identicon determinism", () => {
  it("identicons are distinct SVGs for different addresses", () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)
    const icons = screen.getAllByRole("img", { name: /identicon for/i })
    expect(icons[0].innerHTML).not.toBe(icons[1].innerHTML)
  })

  it("identicon is deterministic across re-renders", () => {
    mockSigners(makeSigners([ADDR_A]))
    const { unmount } = render(<SignerManagement />)
    const svg1 = screen.getByRole("img", { name: /identicon for/i }).innerHTML
    unmount()

    mockSigners(makeSigners([ADDR_A]))
    render(<SignerManagement />)
    const svg2 = screen.getByRole("img", { name: /identicon for/i }).innerHTML
    expect(svg1).toBe(svg2)
  })
})

// ---------------------------------------------------------------------------
// Remove signer flow
// ---------------------------------------------------------------------------

describe("SignerManagement — remove signer", () => {
  it("opens a confirmation modal when Remove is clicked", async () => {
    mockSigners(makeSigners([ADDR_A]))
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getAllByRole("button", { name: /remove signer/i })[0])
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/remove signer/i)).toBeInTheDocument()
  })

  it("calls removeSigner with the correct address on Confirm", async () => {
    const removeSigner = vi.fn().mockResolvedValue(undefined)
    mockSigners(makeSigners([ADDR_A]), { removeSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getAllByRole("button", { name: /remove signer/i })[0])
    await user.click(screen.getByRole("button", { name: /^confirm$/i }))
    await waitFor(() => expect(removeSigner).toHaveBeenCalledWith(ADDR_A))
  })

  it("closes the modal when Cancel is clicked", async () => {
    mockSigners(makeSigners([ADDR_A]))
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getAllByRole("button", { name: /remove signer/i })[0])
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /cancel/i }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("shows an error message when removeSigner throws", async () => {
    const removeSigner = vi.fn().mockRejectedValue(new Error("HTTP 403"))
    mockSigners(makeSigners([ADDR_A]), { removeSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getAllByRole("button", { name: /remove signer/i })[0])
    await user.click(screen.getByRole("button", { name: /^confirm$/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/failed to remove signer/i),
    )
  })
})

// ---------------------------------------------------------------------------
// Trigger rotation flow
// ---------------------------------------------------------------------------

describe("SignerManagement — rotation", () => {
  it("opens the rotation confirmation modal when Trigger Rotation is clicked", async () => {
    mockSigners(makeSigners([ADDR_A]))
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/confirm signer rotation/i)).toBeInTheDocument()
  })

  it("lists outgoing signers in the rotation modal", async () => {
    mockSigners(makeSigners([ADDR_A, ADDR_B]))
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveTextContent(/outgoing signer/i)
  })

  it("calls rotateSigners on Confirm Rotation", async () => {
    const rotateSigners = vi.fn().mockResolvedValue(undefined)
    mockSigners(makeSigners([ADDR_A]), { rotateSigners })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    await user.click(screen.getByRole("button", { name: /confirm rotation/i }))
    await waitFor(() => expect(rotateSigners).toHaveBeenCalled())
  })

  it("closes the rotation modal after a successful rotation", async () => {
    const rotateSigners = vi.fn().mockResolvedValue(undefined)
    mockSigners(makeSigners([ADDR_A]), { rotateSigners })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    await user.click(screen.getByRole("button", { name: /confirm rotation/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("shows an error message when rotateSigners throws", async () => {
    const rotateSigners = vi.fn().mockRejectedValue(new Error("Not enough approvals"))
    mockSigners(makeSigners([ADDR_A]), { rotateSigners })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    await user.click(screen.getByRole("button", { name: /confirm rotation/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/failed to rotate signers/i),
    )
  })

  it("cancels the rotation modal without calling rotateSigners", async () => {
    const rotateSigners = vi.fn()
    mockSigners(makeSigners([ADDR_A]), { rotateSigners })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.click(screen.getByRole("button", { name: /trigger rotation/i }))
    await user.click(screen.getByRole("button", { name: /cancel/i }))
    expect(rotateSigners).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Add signer form
// ---------------------------------------------------------------------------

describe("SignerManagement — add signer form", () => {
  it("renders the Add Signer form", () => {
    render(<SignerManagement />)
    expect(screen.getByRole("heading", { name: /add signer/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/address/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/weight/i)).toBeInTheDocument()
  })

  it("shows an address validation error for a malformed address", async () => {
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.type(screen.getByLabelText(/address/i), "NOTAVALIDADDRESS")
    await user.click(screen.getByLabelText(/address/i))
    // Trigger blur
    await user.tab()
    expect(
      screen.getByText(/invalid stellar address/i),
    ).toBeInTheDocument()
  })

  it("shows a weight validation error for a non-integer weight", async () => {
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.type(screen.getByLabelText(/weight/i), "0")
    await user.tab()
    expect(screen.getByText(/weight must be a positive integer/i)).toBeInTheDocument()
  })

  it("calls addSigner with the correct address and weight on submit", async () => {
    const addSigner = vi.fn().mockResolvedValue(undefined)
    mockSigners([], { addSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.type(screen.getByLabelText(/address/i), ADDR_B)
    await user.type(screen.getByLabelText(/weight/i), "5")
    await user.click(screen.getByRole("button", { name: /^add signer$/i }))
    await waitFor(() =>
      expect(addSigner).toHaveBeenCalledWith(ADDR_B, 5),
    )
  })

  it("disables the Add Signer button while the request is in progress", async () => {
    let resolveAdd!: () => void
    const addSigner = vi.fn().mockReturnValue(new Promise<void>((res) => { resolveAdd = res }))
    mockSigners([], { addSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.type(screen.getByLabelText(/address/i), ADDR_B)
    await user.type(screen.getByLabelText(/weight/i), "3")
    await user.click(screen.getByRole("button", { name: /^add signer$/i }))
    expect(screen.getByRole("button", { name: /adding/i })).toBeDisabled()
    resolveAdd()
  })

  it("clears the form after a successful add", async () => {
    const addSigner = vi.fn().mockResolvedValue(undefined)
    mockSigners([], { addSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    const addressInput = screen.getByLabelText(/address/i)
    const weightInput = screen.getByLabelText(/weight/i)
    await user.type(addressInput, ADDR_B)
    await user.type(weightInput, "3")
    await user.click(screen.getByRole("button", { name: /^add signer$/i }))
    await waitFor(() => expect(addSigner).toHaveBeenCalled())
    expect(addressInput).toHaveValue("")
    expect(weightInput).toHaveValue(null)
  })

  it("shows an error when addSigner throws", async () => {
    const addSigner = vi.fn().mockRejectedValue(new Error("HTTP 409"))
    mockSigners([], { addSigner })
    const user = userEvent.setup()
    render(<SignerManagement />)
    await user.type(screen.getByLabelText(/address/i), ADDR_B)
    await user.type(screen.getByLabelText(/weight/i), "1")
    await user.click(screen.getByRole("button", { name: /^add signer$/i }))
    await waitFor(() =>
      expect(screen.getByText(/http 409/i)).toBeInTheDocument(),
    )
  })
})
