import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSettlementHistory, SettlementEvent } from './useSettlementHistory'

const mockFetch = vi.fn()
global.fetch = mockFetch

function makeEvent(overrides: Partial<SettlementEvent> = {}): SettlementEvent {
  return {
    timestamp: 1_700_000_000,
    status: 'Pending',
    actor: null,
    note: null,
    ...overrides,
  }
}

describe('useSettlementHistory', () => {
  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('starts in a loading state when a settlementId is provided', () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })

    const { result } = renderHook(() => useSettlementHistory(42))

    expect(result.current.loading).toBe(true)
  })

  it('does not fetch when settlementId is null', () => {
    const { result } = renderHook(() => useSettlementHistory(null))

    expect(result.current.loading).toBe(false)
    expect(result.current.events).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches the correct endpoint for a given settlementId', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })

    renderHook(() => useSettlementHistory(7))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/treasury/settlements/7/history')
    })
  })

  it('returns events sorted oldest-first regardless of API order', async () => {
    const events: SettlementEvent[] = [
      makeEvent({ timestamp: 1_700_000_200, status: 'Executed' }),
      makeEvent({ timestamp: 1_700_000_000, status: 'Pending' }),
      makeEvent({ timestamp: 1_700_000_100, status: 'Approved' }),
    ]

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => events })

    const { result } = renderHook(() => useSettlementHistory(1))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.events.map(e => e.status)).toEqual(['Pending', 'Approved', 'Executed'])
  })

  it('renders a complete multi-transition timeline: Proposed → Approved → Executed', async () => {
    const events: SettlementEvent[] = [
      makeEvent({ timestamp: 1_700_000_000, status: 'Proposed', actor: 'GBMRCHNT...A1' }),
      makeEvent({ timestamp: 1_700_000_060, status: 'Approved', actor: 'GSGNR...B2', note: 'quorum reached' }),
      makeEvent({ timestamp: 1_700_000_120, status: 'Executed', actor: 'GSGNR...C3' }),
    ]

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => events })

    const { result } = renderHook(() => useSettlementHistory(5))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.events).toHaveLength(3)
    expect(result.current.events[0].status).toBe('Proposed')
    expect(result.current.events[1].status).toBe('Approved')
    expect(result.current.events[1].note).toBe('quorum reached')
    expect(result.current.events[2].status).toBe('Executed')
  })

  it('renders an on-hold then resolved timeline: Pending → OnHold → Resolved', async () => {
    const events: SettlementEvent[] = [
      makeEvent({ timestamp: 1_700_001_000, status: 'Pending' }),
      makeEvent({ timestamp: 1_700_001_100, status: 'OnHold', note: 'compliance review' }),
      makeEvent({ timestamp: 1_700_001_500, status: 'Executed', actor: 'GADMIN...Z9' }),
    ]

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => events })

    const { result } = renderHook(() => useSettlementHistory(9))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.events).toHaveLength(3)
    expect(result.current.events[1].status).toBe('OnHold')
    expect(result.current.events[1].note).toBe('compliance review')
    expect(result.current.events[2].status).toBe('Executed')
  })

  it('surfaces an HTTP error as the error string', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

    const { result } = renderHook(() => useSettlementHistory(99))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('HTTP 404')
    expect(result.current.events).toEqual([])
  })

  it('surfaces a network error as the error string', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'))

    const { result } = renderHook(() => useSettlementHistory(3))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Network failure')
    expect(result.current.events).toEqual([])
  })

  it('refresh re-fetches the history', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [makeEvent()] })

    const { result } = renderHook(() => useSettlementHistory(2))

    await waitFor(() => {
      expect(result.current.events.length).toBe(1)
    })

    const callsBefore = mockFetch.mock.calls.length

    await act(async () => {
      await result.current.refresh()
    })

    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})
