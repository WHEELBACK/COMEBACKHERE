import { useState, useCallback } from "react"
import { InvoicePayment } from "./components/InvoicePayment"
import { RefundRequest } from "./components/RefundRequest"
import { ComplianceManager } from "./components/ComplianceManager"
import { TokenAllowlist } from "./components/TokenAllowlist"
import { BatchExpireInvoices } from "./components/BatchExpireInvoices"
import { TreasuryManager } from "./components/TreasuryManager"
import { LanguageSwitcher } from "./components/LanguageSwitcher"
import { useInvoice } from "./hooks/useInvoice"
import { useTheme } from "./hooks/useTheme"
import { useWallet } from "./hooks/useWallet"
import { useT } from "./i18n"
import { CopyableText } from "./components/CopyableText"
import "./App.css"
import "./components/ErrorBoundary.css"

type Tab = "payment" | "refund" | "compliance" | "tokens" | "batch-expire" | "treasury"

function RefundTab() {
  const { invoice, loading, error, loadInvoice, refund } = useInvoice()
  const { address } = useWallet()
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
              <span className="detail-label">{t("refundTab.amountUsdc")}</span>
              <span className="detail-value">{invoice.gross_usdc}</span>
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
  const t = useT()
  const [tab, setTab] = useState<Tab>("payment")

  const handleDisconnect = useCallback(() => {
    disconnect()
    setTab("payment")
  }, [disconnect])

  return (
    <div className="app">
      <header className="app-header" role="banner">
        <h1>{t("app.title")}</h1>
        <div className="header-actions">
          <LanguageSwitcher />
          <div className="wallet-bar">
            {connected ? (
              <>
                <span className="wallet-address" aria-label={t("wallet.connectedAriaLabel", { address: address ?? "" })}>
                  {t("wallet.connected", { address: `${address?.slice(0, 6)}...${address?.slice(-4)}` })}
                </span>
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={handleDisconnect}
                  aria-label={t("wallet.disconnectAriaLabel")}
                >
                  {t("wallet.disconnect")}
                </button>
              </>
            ) : (
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
        ) : null}
      </main>
    </div>
  )
}
