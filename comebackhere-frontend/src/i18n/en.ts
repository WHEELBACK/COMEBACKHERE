/**
 * English dictionary — the canonical source of all user-facing strings.
 *
 * Rules:
 *  - Every key must have an English value here.
 *  - Other language files must satisfy the same `Dictionary` type, so missing
 *    or mis-named keys are caught at compile time.
 *  - Interpolation placeholders use double-braces: {{name}}.
 */
const en = {
  app: {
    title: "ComebackHere",
    language: "Language",
  },

  nav: {
    payInvoice: "Pay Invoice",
    requestRefund: "Request Refund",
    compliance: "Compliance",
    tokenAllowlist: "Token Allowlist",
    batchExpire: "Batch Expire",
    treasury: "Treasury",
  },

  wallet: {
    connect: "Connect Wallet",
    connecting: "Connecting...",
    disconnect: "Disconnect",
    connected: "Connected: {{address}}",
    connectToPayInvoice: "Connect wallet to pay invoice",
    connectAriaLabel: "Connect wallet",
    disconnectAriaLabel: "Disconnect wallet",
    connectedAriaLabel: "Wallet connected: {{address}}",
  },

  invoicePayment: {
    title: "Invoice Payment",
    loadInvoice: "Load Invoice",
    loading: "Loading...",
    loadingInvoice: "Loading invoice...",
    loadInvoiceAriaLabel: "Load invoice",
    loadingAriaLabel: "Loading invoice",
    lookupAriaLabel: "Invoice lookup",
    invoiceIdLabel: "Invoice ID",
    invoiceIdAriaLabel: "Invoice ID for payment",
    invoiceIdPlaceholder: "Enter Invoice ID",
    payInvoice: "Pay Invoice",
    payInvoiceAriaLabel: "Pay invoice #{{id}}",
    cancelInvoice: "Cancel Invoice",
    notAvailableForPayment: "This invoice is not available for payment (status: {{status}}).",
    paymentSuccess: "Payment successful!",
    cancelSuccess: "Invoice cancelled successfully!",
    operationFailed: "Operation failed: {{error}}",
    transactionHash: "Transaction hash:",
    invoiceActionsAriaLabel: "Invoice actions",
    disputeInProgress: "Dispute in progress.",
    disputeWarning:
      "A refund has been requested for this invoice, which opens an escrow dispute and holds the funds. Payment, cancellation, and escrow release are unavailable until the dispute is resolved.",
  },

  invoiceCard: {
    invoiceNumber: "Invoice #{{id}}",
    copyInvoiceId: "Copy invoice ID",
    amountUsdc: "Amount (USDC)",
    grossAmountUsdc: "Gross Amount (USDC)",
    merchant: "Merchant",
    payer: "Payer",
    expiry: "Expiry",
    status: "Status",
    countdown: "Countdown",
    expired: "Expired",
    copyMerchantAddress: "Copy merchant address",
    copyPayerAddress: "Copy payer address",
  },

  refundTab: {
    title: "Request a Refund",
    lookupAriaLabel: "Invoice lookup",
    invoiceIdLabel: "Invoice ID",
    invoiceIdPlaceholder: "Enter Invoice ID",
    invoiceIdAriaLabel: "Invoice ID for refund lookup",
    loadInvoice: "Load Invoice",
    loading: "Loading...",
    loadingAriaLabel: "Loading invoice",
    loadAriaLabel: "Load invoice for refund",
    invoiceNumber: "Invoice #{{id}}",
    copyInvoiceId: "Copy invoice ID",
    amountUsdc: "Amount (USDC)",
    merchant: "Merchant",
    payer: "Payer",
    status: "Status",
    copyMerchantAddress: "Copy merchant address",
    copyPayerAddress: "Copy payer address",
  },

  refundRequest: {
    reasonLabel: "Reason for Refund",
    reasonRequired: "required",
    reasonHint: "Full refund only. Provide a reason (minimum {{min}} characters).",
    reasonPlaceholder: "e.g., Product was not as described, duplicate charge, etc.",
    reasonError: {
      required: "Reason is required",
      tooShort: "Reason must be at least {{min}} characters",
      tooLong: "Reason must not exceed {{max}} characters",
    },
    reasonCounter: "{{count}} / {{max}} characters",
    requestRefund: "Request Refund",
    requestRefundAriaLabel: "Request refund for invoice #{{id}}",
    refundSuccess: "Refund requested successfully!",
    transactionHash: "Transaction hash:",
    refundFailed: "Refund request failed: {{error}}",
    refundRequested: "Your refund request has been submitted and is being processed.",
    canOnlyRefundPaid: "Refund can only be requested on Paid invoices.",
  },

  paymentReceipt: {
    title: "Payment Receipt",
    subtitle: "COMEBACKHERE Payment Confirmation",
    invoiceId: "Invoice ID",
    merchant: "Merchant",
    amount: "Amount",
    token: "Token",
    transactionHash: "Transaction Hash",
    timestamp: "Timestamp",
    viewOnExplorer: "View on Explorer",
    printReceipt: "Print Receipt",
    copyTxHash: "Copy transaction hash",
    copyInvoiceId: "Copy invoice ID",
    copyMerchantAddress: "Copy merchant address",
    statusPaid: "PAID",
    poweredBy: "Powered by COMEBACKHERE Protocol",
  },

  qrCode: {
    title: "Payment QR Code",
    description: "Scan this QR code to open the payment page for Invoice #{{id}}",
    downloadButton: "Download QR Code",
    downloadAriaLabel: "Download QR code as PNG",
    downloadTitle: "Download QR code as PNG image",
    share: "Share",
    sharing: "Sharing...",
    copyUrl: "Copy URL",
    showPaymentUrl: "Show Payment URL",
    shareError: "Share failed or was cancelled",
  },

  invoiceTimeline: {
    title: "Invoice Timeline",
    loading: "Loading timeline...",
    empty: "No events recorded for this invoice yet.",
    errorPrefix: "Failed to load timeline: {{error}}",
    retry: "Retry",
    viewOnExplorer: "View transaction",
    currentState: "Current state",
    events: {
      invoice_created: "Invoice Created",
      invoice_paid: "Invoice Paid",
      invoice_expired: "Invoice Expired",
      invoice_cancelled: "Invoice Cancelled",
      refund_requested: "Refund Requested",
      escrow_released: "Escrow Released",
      dispute_raised: "Dispute Raised",
      dispute_resolved: "Dispute Resolved",
      settlement_proposed: "Settlement Proposed",
      settlement_executed: "Settlement Executed",
    },
  },

  common: {
    copyTransactionHash: "Copy transaction hash",
    loading: "Loading...",
    error: "Error",
    retry: "Retry",
    close: "Close",
    confirm: "Confirm",
    cancel: "Cancel",
  },
} as const

export default en
