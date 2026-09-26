import { useState, useEffect, useCallback } from "react"

export const TABS = [
  "payment",
  "create",
  "invoices",
  "refund",
  "compliance",
  "tokens",
  "batch-expire",
  "treasury",
] as const

export type Tab = (typeof TABS)[number]

export const DEFAULT_TAB: Tab = "payment"

export function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value)
}

/**
 * Parse a location.hash value ("#refund", "#/refund", "") into a Tab,
 * falling back to the default tab for empty or unknown values.
 */
export function parseTabHash(hash: string): Tab {
  let value = hash.replace(/^#\/?/, "")
  try {
    value = decodeURIComponent(value)
  } catch {
    return DEFAULT_TAB
  }
  return isTab(value) ? value : DEFAULT_TAB
}

function readHash(): Tab {
  return typeof window === "undefined" ? DEFAULT_TAB : parseTabHash(window.location.hash)
}

/**
 * Keep the active tab in sync with location.hash so tabs can be deep linked,
 * bookmarked, and navigated with the browser back and forward buttons.
 */
export function useHashTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTabState] = useState<Tab>(readHash)

  useEffect(() => {
    const handleHashChange = () => setTabState(readHash())
    window.addEventListener("hashchange", handleHashChange)
    // Pick up any hash change that happened between render and effect
    handleHashChange()
    return () => window.removeEventListener("hashchange", handleHashChange)
  }, [])

  const setTab = useCallback((next: Tab) => {
    setTabState(next)
    // Assigning location.hash pushes a history entry, which is what makes
    // the back button return to the previous tab. Skip it if already there
    // so repeated clicks do not pile up duplicate entries.
    if (window.location.hash !== `#${next}`) {
      window.location.hash = next
    }
  }, [])

  return [tab, setTab]
}
