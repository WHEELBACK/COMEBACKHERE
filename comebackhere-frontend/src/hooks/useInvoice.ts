import { useState, useCallback, useEffect, useRef } from "react"
import { InvoiceStatus, type Invoice, type PaymentResult } from "../types"
import { fetchInvoice, payInvoice, cancelInvoice, requestRefund, releaseEscrow } from "../utils/soroban"

const CONTRACT_ID = import.meta.env.VITE_INVOICE_CONTRACT_ID as string

interface UseInvoiceReturn {
  invoice: Invoice | null
  loading: boolean
  error: string | null
  loadInvoice: (id: number) => Promise<void>
  pay: (publicKey: string) => Promise<PaymentResult>
  cancel: (publicKey: string) => Promise<PaymentResult>
  refund: (publicKey: string) => Promise<PaymentResult>
  release: (publicKey: string) => Promise<PaymentResult>
}

const LOAD_TIMEOUT_MS = 30_000

export function useInvoice(accountKey?: string | null): UseInvoiceReturn {
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Drop cached invoice details when the connected account changes.
  const prevAccount = useRef(accountKey)
  useEffect(() => {
    if (prevAccount.current !== accountKey) {
      prevAccount.current = accountKey
      setInvoice(null)
      setError(null)
    }
  }, [accountKey])

  const loadInvoice = useCallback(async (id: number) => {
    setLoading(true)
    setError(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Invoice request timed out")), LOAD_TIMEOUT_MS)
      })
      const result = await Promise.race([fetchInvoice(CONTRACT_ID, id), timeout])
      setInvoice(result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load invoice")
    } finally {
      clearTimeout(timer)
      setLoading(false)
    }
  }, [])

  const pay = useCallback(
    async (publicKey: string): Promise<PaymentResult> => {
      if (!invoice) {
        return { success: false, error: "No invoice loaded" }
      }
      const result = await payInvoice(CONTRACT_ID, Number(invoice.id), publicKey)
      if (result.success) {
        await loadInvoice(Number(invoice.id))
      }
      return result
    },
    [invoice, loadInvoice]
  )

  const cancel = useCallback(
    async (publicKey: string): Promise<PaymentResult> => {
      if (!invoice) {
        return { success: false, error: "No invoice loaded" }
      }
      const previousInvoice = invoice
      setInvoice({ ...invoice, status: InvoiceStatus.Cancelled })

      try {
        const result = await cancelInvoice(CONTRACT_ID, Number(invoice.id), publicKey)
        if (result.success) {
          await loadInvoice(Number(invoice.id))
        } else {
          setInvoice(previousInvoice)
        }
        return result
      } catch (error) {
        setInvoice(previousInvoice)
        throw error
      }
    },
    [invoice, loadInvoice]
  )

  const refund = useCallback(
    async (publicKey: string): Promise<PaymentResult> => {
      if (!invoice) {
        return { success: false, error: "No invoice loaded" }
      }
      const result = await requestRefund(
        CONTRACT_ID,
        Number(invoice.id),
        publicKey
      )
      if (result.success) {
        await loadInvoice(Number(invoice.id))
      }
      return result
    },
    [invoice, loadInvoice]
  )

  const release = useCallback(
    async (publicKey: string): Promise<PaymentResult> => {
      if (!invoice) {
        return { success: false, error: "No invoice loaded" }
      }
      const result = await releaseEscrow(CONTRACT_ID, Number(invoice.id), publicKey)
      if (result.success) {
        await loadInvoice(Number(invoice.id))
      }
      return result
    },
    [invoice, loadInvoice]
  )

  return { invoice, loading, error, loadInvoice, pay, cancel, refund, release }
}
