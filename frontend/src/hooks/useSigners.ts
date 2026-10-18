import { useState, useEffect, useCallback } from 'react'
import { SignerInfo } from '../types'

const API_BASE = '/api'

export function useSigners() {
  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSigners = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/treasury/signers`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSigners(await res.json())
    } catch (e: any) {
      setError(e.message || 'Failed to fetch signers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSigners() }, [fetchSigners])

  const addSigner = useCallback(async (address: string, weight: number) => {
    const res = await fetch(`${API_BASE}/treasury/add-signer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, weight }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const updated: SignerInfo = await res.json()
    setSigners(prev => {
      const idx = prev.findIndex(s => s.address === address)
      return idx >= 0
        ? prev.map(s => s.address === address ? updated : s)
        : [...prev, updated]
    })
  }, [])

  const removeSigner = useCallback(async (address: string) => {
    const res = await fetch(`${API_BASE}/treasury/remove-signer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setSigners(prev => prev.filter(s => s.address !== address))
  }, [])

  const rotateSigners = useCallback(async () => {
    const res = await fetch(`${API_BASE}/treasury/rotate-signers`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await fetchSigners()
  }, [fetchSigners])

  /**
   * Invalidate and re-fetch the signer list.
   *
   * Call this after any external mutation (e.g. a `rotate_signer` transaction
   * submitted outside this hook) to ensure the UI reflects the latest on-chain
   * state rather than showing a potentially stale list.
   */
  const invalidate = useCallback(() => fetchSigners(), [fetchSigners])

  return {
    signers,
    loading,
    error,
    addSigner,
    removeSigner,
    rotateSigners,
    /** Manually re-fetch signers (alias for invalidate). */
    refresh: fetchSigners,
    /**
     * Invalidate the signer list and re-fetch from the API.
     * Intended for use after external mutations such as a rotate_signer
     * transaction submitted from another part of the app.
     */
    invalidate,
  }
}
