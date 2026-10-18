import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { WalletBar } from "../components/WalletBar"
import type { WalletState } from "../hooks/useWallet"

const NETWORK = "Standalone Network ; February 2025"
const PUBLIC = "Public Global Stellar Network ; September 2015"
const ADDRESS = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

const STATES: Record<WalletState["status"], WalletState> = {
  "not-installed": { status: "not-installed" },
  disconnected: { status: "disconnected", error: null },
  connecting: { status: "connecting" },
  rejected: { status: "rejected", reason: "rejected", error: "User rejected" },
  connected: { status: "connected", address: ADDRESS, network: NETWORK },
  "wrong-network": { status: "wrong-network", address: ADDRESS, network: PUBLIC, expectedNetwork: NETWORK },
}

function renderBar(wallet: WalletState, props: Partial<Parameters<typeof WalletBar>[0]> = {}) {
  return render(<WalletBar wallet={wallet} onConnect={vi.fn()} {...props} />)
}

describe("WalletBar — every state has a distinct visual", () => {
  it.each(Object.values(STATES))("tags the root with the $status status", (wallet) => {
    const { container } = renderBar(wallet)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute("data-wallet-status", wallet.status)
    expect(root).toHaveClass(`wallet-bar--${wallet.status}`)
  })

  it("renders different markup for each state", () => {
    const html = Object.values(STATES).map((wallet) => renderBar(wallet).container.innerHTML)
    expect(new Set(html).size).toBe(html.length)
  })
})

describe("WalletBar — disconnected state", () => {
  it("renders connect wallet button", () => {
    renderBar(STATES.disconnected)
    expect(screen.getByTestId("connect-wallet-btn")).toBeEnabled()
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument()
  })

  it("button calls onConnect when clicked", async () => {
    const onConnect = vi.fn()
    renderBar(STATES.disconnected, { onConnect })
    await userEvent.click(screen.getByTestId("connect-wallet-btn"))
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it("does not render wallet address or alerts", () => {
    renderBar(STATES.disconnected)
    expect(screen.queryByTestId("wallet-address")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("WalletBar — disconnected with a generic error", () => {
  const wallet: WalletState = { status: "disconnected", error: "Connection failed" }

  it("renders the error with an icon", () => {
    renderBar(wallet)
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed")
    expect(screen.getByText("❌")).toBeInTheDocument()
  })

  it("try again calls onRetry, falling back to onConnect", async () => {
    const onRetry = vi.fn()
    const { unmount } = renderBar(wallet, { onRetry })
    await userEvent.click(screen.getByTestId("retry-connect-btn"))
    expect(onRetry).toHaveBeenCalledOnce()
    unmount()

    const onConnect = vi.fn()
    renderBar(wallet, { onConnect })
    await userEvent.click(screen.getByTestId("retry-connect-btn"))
    expect(onConnect).toHaveBeenCalledOnce()
  })
})

describe("WalletBar — connecting state", () => {
  it("shows a spinner, a hint, and a disabled button", () => {
    const { container } = renderBar(STATES.connecting)
    expect(container.querySelector(".wallet-spinner")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(/approve the request in Freighter/)
    expect(screen.getByTestId("connect-wallet-btn")).toBeDisabled()
    expect(screen.getByText("Connecting...")).toBeInTheDocument()
  })
})

describe("WalletBar — rejected state", () => {
  it("shows the rejection with a try again action", async () => {
    const onRetry = vi.fn()
    renderBar(STATES.rejected, { onRetry })
    expect(screen.getByRole("alert")).toHaveTextContent("Connection request rejected")
    expect(screen.getByText("🚫")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("retry-connect-btn"))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("shows a locked variant with unlock and retry", async () => {
    const onRetry = vi.fn()
    renderBar({ status: "rejected", reason: "locked", error: "Wallet is locked" }, { onRetry })
    expect(screen.getByText("Wallet is locked")).toBeInTheDocument()
    expect(screen.getByText("🔒")).toBeInTheDocument()
    const btn = screen.getByTestId("unlock-wallet-btn")
    expect(btn).toHaveTextContent("Unlock & Retry")
    await userEvent.click(btn)
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe("WalletBar — not installed state", () => {
  it("renders the message and an install link", () => {
    renderBar(STATES["not-installed"])
    expect(screen.getByRole("alert")).toHaveTextContent("Freighter wallet not detected")
    expect(screen.getByText("⚠️")).toBeInTheDocument()
    const link = screen.getByText("Install Extension")
    expect(link).toHaveAttribute("href", "https://www.freighter.app/")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })
})

describe("WalletBar — connected state", () => {
  it("renders the truncated address with the full address accessible", () => {
    renderBar(STATES.connected)
    const addr = screen.getByTestId("wallet-address")
    expect(addr).toHaveTextContent(`GBDXOE...${ADDRESS.slice(-4)}`)
    expect(addr).toHaveAttribute("aria-label", `Wallet connected: ${ADDRESS}`)
  })

  it("has no connect button or network warning", () => {
    renderBar(STATES.connected)
    expect(screen.queryByTestId("connect-wallet-btn")).not.toBeInTheDocument()
    expect(screen.queryByTestId("network-warning")).not.toBeInTheDocument()
  })

  it("renders disconnect only when a handler is provided", async () => {
    const { unmount } = renderBar(STATES.connected)
    expect(screen.queryByTestId("disconnect-wallet-btn")).not.toBeInTheDocument()
    unmount()

    const onDisconnect = vi.fn()
    renderBar(STATES.connected, { onDisconnect })
    await userEvent.click(screen.getByTestId("disconnect-wallet-btn"))
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})

describe("WalletBar — wrong-network state", () => {
  it("renders a network warning naming both networks", () => {
    renderBar(STATES["wrong-network"])
    const warning = screen.getByTestId("network-warning")
    expect(warning).toHaveAttribute("role", "alert")
    expect(warning).toHaveTextContent("Wrong network (Public Global Stellar Network)")
    expect(warning).toHaveTextContent("Switch Freighter to Standalone Network")
    expect(warning).toHaveTextContent(NETWORK)
  })

  it("still shows the wallet address and disconnect", () => {
    renderBar(STATES["wrong-network"], { onDisconnect: vi.fn() })
    expect(screen.getByTestId("wallet-address")).toBeInTheDocument()
    expect(screen.getByTestId("disconnect-wallet-btn")).toBeInTheDocument()
  })
})

describe("WalletBar — transitions", () => {
  const TRANSITIONS: Array<[WalletState["status"], WalletState["status"]]> = [
    ["disconnected", "connecting"],
    ["connecting", "connected"],
    ["connecting", "rejected"],
    ["connecting", "wrong-network"],
    ["rejected", "connecting"],
    ["wrong-network", "connected"],
    ["connected", "wrong-network"],
    ["connected", "disconnected"],
    ["not-installed", "disconnected"],
  ]

  it.each(TRANSITIONS)("%s → %s swaps the visual and replays the enter animation", (from, to) => {
    const { container, rerender } = renderBar(STATES[from])
    const before = container.querySelector(".wallet-bar__state")
    expect(before).toHaveClass("wallet-bar__state")

    rerender(<WalletBar wallet={STATES[to]} onConnect={vi.fn()} />)

    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute("data-wallet-status", to)
    // Keyed on status, so the wrapper is a fresh element that animates in
    expect(container.querySelector(".wallet-bar__state")).not.toBe(before)
  })

  it("keeps the same element when the state does not change status", () => {
    const { container, rerender } = renderBar(STATES.connected)
    const before = container.querySelector(".wallet-bar__state")
    rerender(<WalletBar wallet={{ ...STATES.connected }} onConnect={vi.fn()} />)
    expect(container.querySelector(".wallet-bar__state")).toBe(before)
  })
})
