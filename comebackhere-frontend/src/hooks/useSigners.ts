import { useState, useEffect, useCallback } from "react"

export interface SignerInfo {
  address: string
  weight: number
}

const API_BASE = (import.meta.env.VITE_API_BASE as string) ?? "/api"

/**
 * Hook that manages the treasury signer list for the canonical frontend.
 *
 * Fetches the current signer list from the backend on mount and exposes
 * helpers to add, remove, rotate, and refresh signers. The `get_signers`
 * contract view is used via the backend proxy when available.
 */
export function useSigners() {
  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSigners = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/treasury/signers`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSigners(await res.json())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch signers")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSigners()
  }, [fetchSigners])

  const addSigner = useCallback(
    async (address: string, weight: number) => {
      const res = await fetch(`${API_BASE}/treasury/add-signer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, weight }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated: SignerInfo = await res.json()
      setSigners((prev) => {
        const idx = prev.findIndex((s) => s.address === address)
        return idx >= 0
          ? prev.map((s) => (s.address === address ? updated : s))
          : [...prev, updated]
      })
    },
    [],
  )

  const removeSigner = useCallback(async (address: string) => {
    const res = await fetch(`${API_BASE}/treasury/remove-signer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setSigners((prev) => prev.filter((s) => s.address !== address))
  }, [])

  const rotateSigners = useCallback(async () => {
    const res = await fetch(`${API_BASE}/treasury/rotate-signers`, { method: "POST" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await fetchSigners()
  }, [fetchSigners])

  /** Manually re-fetch the signer list. */
  const refresh = fetchSigners

  /**
   * Invalidate and re-fetch. Use after external mutations such as a
   * rotate_signer transaction submitted from another part of the app.
   */
  const invalidate = useCallback(() => fetchSigners(), [fetchSigners])

  return {
    signers,
    loading,
    error,
    addSigner,
    removeSigner,
    rotateSigners,
    refresh,
    invalidate,
  }
}
