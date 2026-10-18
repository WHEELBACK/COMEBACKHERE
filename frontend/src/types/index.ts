export interface Settlement {
  id: number
  merchant_address: string
  amount: string
  approvals: string[]
  approval_weight: number
  status: 'Pending' | 'Executed' | 'PartiallyExecuted' | 'OnHold' | 'Cancelled'
  hold_reason: string | null
  proposed_tx_hash?: string
  executed_tx_hash?: string
}

export interface SignerInfo {
  address: string
  weight: number
}

export interface SettlementApprovalProps {
  signerAddress: string
  threshold: number
}

export type InvoiceStatus =
  | 'Pending'
  | 'Paid'
  | 'Expired'
  | 'Cancelled'
  | 'RefundRequested'
  | 'Released'

export interface Invoice {
  id: string
  merchant: string
  payer: string
  amount_usdc: string
  gross_usdc: string
  expires_at: number
  status: InvoiceStatus
  paid_at: number | null
  created_at: number | null
}
