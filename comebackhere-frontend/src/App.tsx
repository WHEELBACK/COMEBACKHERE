import { useState, useEffect } from "react"
import { InvoicePayment } from "./components/InvoicePayment"
import { RefundRequest } from "./components/RefundRequest"
import { ComplianceManager } from "./components/ComplianceManager"
import { WalletBar } from "./components/WalletBar"
import { useInvoice } from "./hooks/useInvoice"
import { useWallet } from "./hooks/useWallet"
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

      <div className="invoice-lookup">
        <input
          type="number"
          placeholder="Enter Invoice ID"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
        />
        <button
          className="btn btn--primary"
          onClick={handleLoadInvoice}
          disabled={!invoiceId || loading}
        >
          {loading ? "Loading..." : "Load Invoice"}
        </button>
      </div>

      {error && <div className="message message--error">{error}</div>}

      {invoice && (
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h3>Invoice #{invoice.id}</h3>
          </div>
          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Amount (USDC)</span>
              <span className="detail-value">{invoice.gross_usdc}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Merchant</span>
              <span className="detail-value detail-value--address">
                {invoice.merchant}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Payer</span>
              <span className="detail-value detail-value--address">
                {invoice.payer}
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
  const [tab, setTab] = useState<Tab>("payment")
  const [network, setNetwork] = useState<string | null>(null)

  useEffect(() => {
    const detect = async () => {
      if ((window as any).freighterApi?.getNetwork) {
        try {
          const { network: n } = await (window as any).freighterApi.getNetwork()
          setNetwork(n)
        } catch {
          setNetwork(null)
        }
      }
    }
    if (connected) detect()
  }, [connected])

  return (
    <div className="app">
      <header className="app-header">
        <h1>ComebackHere</h1>
        <WalletBar
          connected={connected}
          connecting={connecting}
          address={address}
          network={network}
          expectedNetwork={EXPECTED_NETWORK}
          onConnect={connect}
        />
      </header>

      <nav className="tabs">
        <button
          className={`tab ${tab === "payment" ? "tab--active" : ""}`}
          onClick={() => setTab("payment")}
        >
          Pay Invoice
        </button>
        <button
          className={`tab ${tab === "refund" ? "tab--active" : ""}`}
          onClick={() => setTab("refund")}
        >
          Request Refund
        </button>
        <button
          className={`tab ${tab === "compliance" ? "tab--active" : ""}`}
          onClick={() => setTab("compliance")}
        >
          Compliance
        </button>
      </nav>

      <main className="app-main">
        {tab === "payment" ? (
          <InvoicePayment />
        ) : tab === "refund" ? (
          <RefundTab />
        ) : (
          <ComplianceManager />
        )}
      </main>
    </div>
  )
}
