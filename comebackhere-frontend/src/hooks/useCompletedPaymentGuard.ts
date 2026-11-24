import { useCallback } from "react"

const KEY = "cbh:completedPayments"

function read(): string[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Remembers invoices paid in this browser session so that back/forward
 * navigation (including bfcache restores) cannot submit the payment again.
 */
export function useCompletedPaymentGuard() {
  const isCompleted = useCallback((id: string | number) => read().includes(String(id)), [])
  const markCompleted = useCallback((id: string | number) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...read(), String(id)]))
    } catch {
      // storage unavailable; the on-chain status check remains the backstop
    }
  }, [])
  return { isCompleted, markCompleted }
}
