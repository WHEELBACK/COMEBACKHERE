import { useState, useCallback, useRef, useEffect } from "react"
import { InvoicePayment } from "./components/InvoicePayment"
import { RefundRequest } from "./components/RefundRequest"
import { ComplianceManager } from "./components/ComplianceManager"
import { TokenAllowlist } from "./components/TokenAllowlist"
import { BatchExpireInvoices } from "./components/BatchExpireInvoices"
import { TreasuryManager } from "./components/TreasuryManager"
import { useInvoice } from "./hooks/useInvoice"
import { useTheme } from "./hooks/useTheme"
import { useWallet } from "./hooks/useWallet"
import { CopyableText } from "./components/CopyableText"
import "./App.css"
import "./components/ErrorBoundary.css"

type Tab = "payment" | "refund" | "compliance" | "tokens" | "batch-expire" | "treasury"

const TABS: { id: Tab; label: string }[] = [
  { id: "payment", label: "Pay Invoice" },
  { id: "refund", label: "Request Refund" },
  { id: "compliance", label: "Compliance" },
  { id: "tokens", label: "Token Allowlist" },
  { id: "batch-expire", label: "Batch Expire" },
  { id: "treasury", label: "Treasury" },
]

function RefundTab() {
  const { invoice, loading, error, loadInvoice, refund } = useInvoice()
  const { address } = useWallet()
  const [invoiceId, setInvoiceId] = useState("")

  const handleLoadInvoice = async () => {
    await loadInvoice(Number(invoiceId))
  }

  return (
    <div className="refund-flow">
      <h2>Request a Refund</h2>

      <div className="invoice-lookup" role="search" aria-label="Invoice lookup">
        <label htmlFor="refund-invoice-id" className="sr-only">Invoice ID</label>
        <input
          id="refund-invoice-id"
          type="number"
          placeholder="Enter Invoice ID"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          aria-label="Invoice ID for refund lookup"
        />
        <button
          className="btn btn--primary"
          onClick={handleLoadInvoice}
          disabled={!invoiceId || loading}
          aria-label={loading ? "Loading invoice" : "Load invoice for refund"}
        >
          {loading ? "Loading..." : "Load Invoice"}
        </button>
      </div>

      {error && <div className="message message--error">{error}</div>}

      {invoice && (
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h3>Invoice #<CopyableText text={String(invoice.id)} label="Copy invoice ID" /></h3>
          </div>
          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Amount (USDC)</span>
              <span className="detail-value">{invoice.gross_usdc}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Merchant</span>
              <span className="detail-value detail-value--address">
                <CopyableText text={invoice.merchant} label="Copy merchant address" />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Payer</span>
              <span className="detail-value detail-value--address">
                <CopyableText text={invoice.payer} label="Copy payer address" />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <span>{invoice.status}</span>
            </div>
          </div>
          <RefundRequest
            invoice={invoice}
            walletAddress={address}
            onRequestRefund={() => refund(address ?? "")}
          />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const { address, connected, connect, connecting, disconnect } = useWallet()
  useTheme()
  const [tab, setTab] = useState<Tab>("payment")
  // Refs for each tab button so we can imperatively move focus (roving tabindex).
  const tabRefs = useRef<Map<Tab, HTMLButtonElement>>(new Map())

  const handleDisconnect = useCallback(() => {
    disconnect()
    setTab("payment")
  }, [disconnect])

  // Activate a tab and move focus to it.
  const activateTab = useCallback((id: Tab) => {
    setTab(id)
    // Focus the button on the next tick so the DOM has updated tabIndex.
    requestAnimationFrame(() => {
      tabRefs.current.get(id)?.focus()
    })
  }, [])

  // Keyboard handler for WAI-ARIA roving tabindex pattern.
  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = TABS.findIndex((t) => t.id === tab)

      switch (event.key) {
        case "ArrowRight": {
          event.preventDefault()
          const next = TABS[(currentIndex + 1) % TABS.length]
          activateTab(next.id)
          break
        }
        case "ArrowLeft": {
          event.preventDefault()
          const prev = TABS[(currentIndex - 1 + TABS.length) % TABS.length]
          activateTab(prev.id)
          break
        }
        case "Home": {
          event.preventDefault()
          activateTab(TABS[0].id)
          break
        }
        case "End": {
          event.preventDefault()
          activateTab(TABS[TABS.length - 1].id)
          break
        }
        // Space and Enter are handled by the default button behaviour (onClick).
        default:
          break
      }
    },
    [tab, activateTab],
  )

  // Sync URL hash with active tab so bookmarks and back-button work.
  useEffect(() => {
    const hash = window.location.hash.slice(1) as Tab
    if (TABS.some((t) => t.id === hash)) {
      setTab(hash)
    }
  }, [])

  useEffect(() => {
    window.history.replaceState(null, "", `#${tab}`)
  }, [tab])

  return (
    <div className="app">
      <header className="app-header" role="banner">
        <h1>ComebackHere</h1>
        <div className="wallet-bar">
          {connected ? (
            <>
              <span className="wallet-address" aria-label={`Wallet connected: ${address}`}>
                Connected: {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <button
                className="btn btn--secondary btn--sm"
                onClick={handleDisconnect}
                aria-label="Disconnect wallet"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              onClick={connect}
              disabled={connecting}
              aria-label="Connect wallet"
            >
              {connecting ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      {/*
        WAI-ARIA Tabs pattern:
        - role="tablist" on the nav
        - role="tab" + aria-selected + aria-controls on each button
        - Roving tabindex: only the active tab has tabIndex={0}; others are -1
        - Arrow / Home / End keys navigate between tabs
      */}
      <nav className="tabs" role="tablist" aria-label="Main navigation">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={(el) => {
              if (el) tabRefs.current.set(id, el)
              else tabRefs.current.delete(id)
            }}
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`tab ${tab === id ? "tab--active" : ""}`}
            onClick={() => activateTab(id)}
            onKeyDown={handleTabKeyDown}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {/*
          Each panel uses role="tabpanel" + aria-labelledby pointing back to
          its controlling tab button, and tabIndex={0} so the panel itself is
          reachable after Tab leaves the tablist.
        */}
        <div
          role="tabpanel"
          id="tabpanel-payment"
          aria-labelledby="tab-payment"
          tabIndex={0}
          hidden={tab !== "payment"}
        >
          <InvoicePayment />
        </div>
        <div
          role="tabpanel"
          id="tabpanel-refund"
          aria-labelledby="tab-refund"
          tabIndex={0}
          hidden={tab !== "refund"}
        >
          <RefundTab />
        </div>
        <div
          role="tabpanel"
          id="tabpanel-compliance"
          aria-labelledby="tab-compliance"
          tabIndex={0}
          hidden={tab !== "compliance"}
        >
          <ComplianceManager />
        </div>
        <div
          role="tabpanel"
          id="tabpanel-tokens"
          aria-labelledby="tab-tokens"
          tabIndex={0}
          hidden={tab !== "tokens"}
        >
          <TokenAllowlist />
        </div>
        <div
          role="tabpanel"
          id="tabpanel-batch-expire"
          aria-labelledby="tab-batch-expire"
          tabIndex={0}
          hidden={tab !== "batch-expire"}
        >
          <BatchExpireInvoices walletAddress={address} />
        </div>
        <div
          role="tabpanel"
          id="tabpanel-treasury"
          aria-labelledby="tab-treasury"
          tabIndex={0}
          hidden={tab !== "treasury"}
        >
          <TreasuryManager />
        </div>
      </main>
    </div>
  )
}
