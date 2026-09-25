import { useState, useCallback } from "react"
import { InvoicePayment } from "./components/InvoicePayment"
import { RefundRequest } from "./components/RefundRequest"
import { ComplianceManager } from "./components/ComplianceManager"
import { TokenAllowlist } from "./components/TokenAllowlist"
import { BatchExpireInvoices } from "./components/BatchExpireInvoices"
import { TreasuryManager } from "./components/TreasuryManager"
import SignerManagement from "./components/SignerManagement/SignerManagement"
import { useInvoice } from "./hooks/useInvoice"
import { useTheme } from "./hooks/useTheme"
import { useWallet } from "./hooks/useWallet"
import { useHashTab, TABS, type Tab } from "./hooks/useHashTab"
import { CopyableText } from "./components/CopyableText"
import { formatAmount, USDC_DECIMALS } from "./utils/format"
import NetworkMismatchBanner from "./components/NetworkMismatchBanner"
import OnboardingWizard, { useOnboarding } from "./components/OnboardingWizard"
import "./App.css"
import "./components/ErrorBoundary.css"

type Tab = "payment" | "refund" | "compliance" | "tokens" | "batch-expire" | "treasury" | "signers"

function RefundTab() {
  const { invoice, loading, error, loadInvoice, refund } = useInvoice()
  const { address, notReadyReason } = useWallet()
  const [invoiceId, setInvoiceId] = useState("")
  const t = useT()

  const handleLoadInvoice = async () => {
    await loadInvoice(Number(invoiceId))
  }

  return (
    <div className="refund-flow">
      <h2>{t("refundTab.title")}</h2>

      <div className="invoice-lookup" role="search" aria-label={t("refundTab.lookupAriaLabel")}>
        <label htmlFor="refund-invoice-id" className="sr-only">{t("refundTab.invoiceIdLabel")}</label>
        <input
          id="refund-invoice-id"
          type="number"
          placeholder={t("refundTab.invoiceIdPlaceholder")}
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          aria-label={t("refundTab.invoiceIdAriaLabel")}
        />
        <button
          className="btn btn--primary"
          onClick={handleLoadInvoice}
          disabled={!invoiceId || loading}
          aria-label={loading ? t("refundTab.loadingAriaLabel") : t("refundTab.loadAriaLabel")}
        >
          {loading ? t("refundTab.loading") : t("refundTab.loadInvoice")}
        </button>
      </div>

      {error && <div className="message message--error">{error}</div>}

      {invoice && (
        <div className="invoice-card">
          <div className="invoice-card__header">
            <h3>{t("refundTab.invoiceNumber", { id: invoice.id })}<CopyableText text={String(invoice.id)} label={t("refundTab.copyInvoiceId")} /></h3>
          </div>
          <div className="invoice-card__body">
            <div className="detail-row">
              <span className="detail-label">Amount</span>
              <span className="detail-value">{formatAmount(invoice.gross_usdc, USDC_DECIMALS, "USDC")}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("refundTab.merchant")}</span>
              <span className="detail-value detail-value--address">
                <CopyableText text={invoice.merchant} label={t("refundTab.copyMerchantAddress")} />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("refundTab.payer")}</span>
              <span className="detail-value detail-value--address">
                <CopyableText text={invoice.payer} label={t("refundTab.copyPayerAddress")} />
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">{t("refundTab.status")}</span>
              <span>{invoice.status}</span>
            </div>
          </div>
          <RefundRequest
            invoice={invoice}
            walletAddress={address}
            walletNotReadyReason={notReadyReason}
            onRequestRefund={() => refund(address ?? "")}
          />
        </div>
      )}
    </div>
  )
}

interface TabContext {
  address: string | null
  notReadyReason: string | null
  setTab: (tab: Tab) => void
  openInvoice: (invoiceId: string) => void
}

function renderTab(tab: Tab, { address, notReadyReason, setTab, openInvoice }: TabContext) {
  switch (tab) {
    case "payment":
      return <InvoicePayment />
    case "create":
      return <CreateInvoice merchantAddress={address} />
    case "invoices":
      return (
        <InvoiceList
          merchantAddress={address}
          onOpenInvoice={openInvoice}
          onCreateInvoice={() => setTab("create")}
        />
      )
    case "refund":
      return <RefundTab />
    case "tokens":
      return <TokenAllowlist />
    case "compliance":
      return <ComplianceManager />
    case "batch-expire":
      return <BatchExpireInvoices walletAddress={address} walletNotReadyReason={notReadyReason} />
    case "treasury":
      return <TreasuryManager />
    default: {
      const unreachable: never = tab
      return unreachable
    }
  }
}

export default function App() {
  const { address, network, connected, connect, connecting, disconnect, error: walletError } = useWallet()
  const { showWizard, openWizard, closeWizard } = useOnboarding()
  useTheme()
  const [tab, setTab] = useHashTab()

  const handleDisconnect = useCallback(() => {
    disconnect()
    setTab("payment")
  }, [disconnect, setTab])

  // Open an invoice from the list in the payment tab. InvoicePayment loads
  // ?invoiceId= on mount, so the resulting URL is also shareable.
  const openInvoice = useCallback((invoiceId: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set("invoiceId", invoiceId)
    window.history.replaceState(window.history.state, "", url)
    setTab("payment")
  }, [setTab])

  return (
    <div className="app">
      <header className="app-header" role="banner">
        <h1>ComebackHere</h1>
        <div className="wallet-bar">
          <button
            className="btn btn--secondary btn--sm"
            onClick={openWizard}
            aria-label="Open setup guide"
          >
            Setup guide
          </button>
          {connected ? (
            <>
              <span className="wallet-address" aria-label={`Wallet connected: ${address}`}>
                Connected: {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <button
                className="btn btn--primary btn--sm"
                onClick={connect}
                disabled={connecting}
                aria-label={t("wallet.connectAriaLabel")}
              >
                {connecting ? t("wallet.connecting") : t("wallet.connect")}
              </button>
            )}
          </div>
        </div>
      </header>

      <NetworkMismatchBanner
        walletPassphrase={network}
        connected={connected}
        connecting={connecting}
      />

      <nav className="tabs" role="tablist" aria-label="Main navigation">
        <button
          role="tab"
          aria-selected={tab === "payment"}
          aria-controls="tabpanel-payment"
          id="tab-payment"
          className={`tab ${tab === "payment" ? "tab--active" : ""}`}
          onClick={() => setTab("payment")}
        >
          {t("nav.payInvoice")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "refund"}
          aria-controls="tabpanel-refund"
          id="tab-refund"
          className={`tab ${tab === "refund" ? "tab--active" : ""}`}
          onClick={() => setTab("refund")}
        >
          {t("nav.requestRefund")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "compliance"}
          aria-controls="tabpanel-compliance"
          id="tab-compliance"
          className={`tab ${tab === "compliance" ? "tab--active" : ""}`}
          onClick={() => setTab("compliance")}
        >
          {t("nav.compliance")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "tokens"}
          aria-controls="tabpanel-tokens"
          id="tab-tokens"
          className={`tab ${tab === "tokens" ? "tab--active" : ""}`}
          onClick={() => setTab("tokens")}
        >
          {t("nav.tokenAllowlist")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "batch-expire"}
          aria-controls="tabpanel-batch-expire"
          id="tab-batch-expire"
          className={`tab ${tab === "batch-expire" ? "tab--active" : ""}`}
          onClick={() => setTab("batch-expire")}
        >
          {t("nav.batchExpire")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "treasury"}
          aria-controls="tabpanel-treasury"
          id="tab-treasury"
          className={`tab ${tab === "treasury" ? "tab--active" : ""}`}
          onClick={() => setTab("treasury")}
        >
          {t("nav.treasury")}
        </button>
        {connected && (
          <button
            role="tab"
            aria-selected={tab === "signers"}
            aria-controls="tabpanel-signers"
            id="tab-signers"
            className={`tab ${tab === "signers" ? "tab--active" : ""}`}
            onClick={() => setTab("signers")}
          >
            Signers
          </button>
        )}
      </nav>

      <main className="app-main">
        {tab === "payment" ? (
          <InvoicePayment />
        ) : tab === "refund" ? (
          <RefundTab />
        ) : tab === "tokens" ? (
          <TokenAllowlist />
        ) : tab === "compliance" ? (
          <ComplianceManager />
        ) : tab === "batch-expire" ? (
          <BatchExpireInvoices walletAddress={address} />
        ) : tab === "treasury" ? (
          <TreasuryManager />
        ) : tab === "signers" && connected ? (
          <SignerManagement />
        ) : null}
      </main>

      {showWizard && (
        <OnboardingWizard
          onComplete={closeWizard}
          onDismiss={closeWizard}
          walletAddress={address}
          walletError={walletError}
          onConnectWallet={connect}
        />
      )}
    </div>
  )
}
