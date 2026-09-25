import { useCallback } from "react"
import type { Invoice } from "../types"
import { useT } from "../i18n"
import { CopyableText } from "./CopyableText"

interface PaymentReceiptProps {
  invoice: Invoice
  transactionHash: string
  /** Unix timestamp (seconds) when the payment was confirmed. */
  paidAt: number
  /** Base URL for the block explorer — defaults to Stellar Expert testnet. */
  explorerBaseUrl?: string
}

const DEFAULT_EXPLORER = "https://stellar.expert/explorer/testnet/tx"

export function PaymentReceipt({
  invoice,
  transactionHash,
  paidAt,
  explorerBaseUrl = DEFAULT_EXPLORER,
}: PaymentReceiptProps) {
  const t = useT()

  const explorerUrl = `${explorerBaseUrl}/${transactionHash}`

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  return (
    <section
      className="payment-receipt"
      aria-label={t("paymentReceipt.title")}
      data-testid="payment-receipt"
    >
      <div className="payment-receipt__header">
        <h2 className="payment-receipt__title">{t("paymentReceipt.title")}</h2>
        <span className="payment-receipt__badge">{t("paymentReceipt.statusPaid")}</span>
      </div>

      <div className="payment-receipt__body">
        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.invoiceId")}</span>
          <span className="detail-value">
            <CopyableText
              text={String(invoice.id)}
              label={t("paymentReceipt.copyInvoiceId")}
            />
          </span>
        </div>

        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.merchant")}</span>
          <span className="detail-value detail-value--address">
            <CopyableText
              text={invoice.merchant}
              label={t("paymentReceipt.copyMerchantAddress")}
            />
          </span>
        </div>

        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.amount")}</span>
          <span className="detail-value">{invoice.gross_usdc}</span>
        </div>

        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.token")}</span>
          <span className="detail-value">USDC</span>
        </div>

        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.transactionHash")}</span>
          <span className="detail-value">
            <code className="tx-hash">
              <CopyableText
                text={transactionHash}
                label={t("paymentReceipt.copyTxHash")}
              />
            </code>
          </span>
        </div>

        <div className="detail-row">
          <span className="detail-label">{t("paymentReceipt.timestamp")}</span>
          <span className="detail-value">
            {new Date(paidAt * 1000).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="payment-receipt__actions">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--secondary btn--sm"
          aria-label={t("paymentReceipt.viewOnExplorer")}
        >
          🔗 {t("paymentReceipt.viewOnExplorer")}
        </a>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={handlePrint}
          aria-label={t("paymentReceipt.printReceipt")}
        >
          🖨️ {t("paymentReceipt.printReceipt")}
        </button>
      </div>

      <div className="payment-receipt__footer">
        {t("paymentReceipt.poweredBy")}
      </div>
    </section>
  )
}
