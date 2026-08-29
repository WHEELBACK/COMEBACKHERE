import { useState, useEffect, useCallback } from 'react'

const API_BASE = '/api'

export interface SettlementEvent {
  /** Unix timestamp (seconds) when the transition occurred */
  timestamp: number
  /** The status the settlement transitioned to */
  status: string
  /** Optional address of the actor who triggered the transition */
  actor?: string | null
  /** Optional contextual note (e.g. hold reason, dispute reference) */
  note?: string | null
}

export function useSettlementHistory(settlementId: number | null) {
  const [events, setEvents] = useState<SettlementEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchHistory = useCallback(async () => {
    if (settlementId === null) return
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/treasury/settlements/${settlementId}/history`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: SettlementEvent[] = await res.json()
      // Ensure events are sorted oldest-first so the timeline reads top-to-bottom
      const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp)
      setEvents(sorted)
    } catch (e: any) {
      setError(e.message || 'Failed to fetch settlement history')
    } finally {
      setLoading(false)
    }
  }, [settlementId])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  return { events, loading, error, refresh: fetchHistory }
}
