import { useState } from "react"
import { InvoicePayment } from "./components/InvoicePayment"
import { RefundRequest } from "./components/RefundRequest"
import { ComplianceManager } from "./components/ComplianceManager"
import { WalletBar } from "./components/WalletBar"
import { useInvoice } from "./hooks/useInvoice"
import { useTheme } from "./hooks/useTheme"
import { useWallet } from "./hooks/useWallet"
import { CopyableText } from "./components/CopyableText"
import "./App.css"

const EXPECTED_NETWORK = import.meta.env.VITE_NETWORK_PASSPHRASE as string ?? "Standalone Network ; February 2025"

type Tab = "payment" | "refund" | "compliance"

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
  const { address, connected, connect, connecting } = useWallet()
  const { theme, toggleTheme } = useTheme()
  const [tab, setTab] = useState<Tab>("payment")
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <div className="app">
      <header className="app-header" role="banner">
        <h1>ComebackHere</h1>
        <div className="wallet-bar">
          {connected ? (
            <span className="wallet-address" aria-label={`Wallet connected: ${address}`}>
              Connected: {address?.slice(0, 6)}...{address?.slice(-4)}
            </span>
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

      <nav className="tabs" role="tablist" aria-label="Main navigation">
        <button
          role="tab"
          aria-selected={tab === "payment"}
          aria-controls="tabpanel-payment"
          id="tab-payment"
          className={`tab ${tab === "payment" ? "tab--active" : ""}`}
          onClick={() => setTab("payment")}
        >
          Pay Invoice
        </button>
        <button
          role="tab"
          aria-selected={tab === "refund"}
          aria-controls="tabpanel-refund"
          id="tab-refund"
          className={`tab ${tab === "refund" ? "tab--active" : ""}`}
          onClick={() => setTab("refund")}
        >
          Request Refund
        </button>
        <button
          role="tab"
          aria-selected={tab === "compliance"}
          aria-controls="tabpanel-compliance"
          id="tab-compliance"
          className={`tab ${tab === "compliance" ? "tab--active" : ""}`}
          onClick={() => setTab("compliance")}
        >
          Compliance
        </button>
        <button
          className={`tab ${tab === "analytics" ? "tab--active" : ""}`}
          onClick={() => setTab("analytics")}
        >
          Analytics
        </button>
      </nav>

      <main
        className="app-main"
        role="tabpanel"
        id={`tabpanel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "payment" ? (
          <InvoicePayment />
        ) : tab === "refund" ? (
          <RefundTab />
        ) : tab === "compliance" ? (
          <ComplianceManager />
        ) : (
          <AdminAnalytics />
        )}
      </main>
    </div>
  )
}
