import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSigners } from './useSigners'
import { SignerInfo } from '../types'

const mockFetch = vi.fn()
global.fetch = mockFetch

function makeSigner(overrides: Partial<SignerInfo> = {}): SignerInfo {
  return {
    address: 'GABC...SIGNER1',
    weight: 10,
    ...overrides,
  }
}

describe('useSigners', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockClear()
  })

  describe('fetchSigners', () => {
    it('should start in a loading state', () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })

      const { result } = renderHook(() => useSigners())

      expect(result.current.loading).toBe(true)
    })

    it('should fetch signers successfully', async () => {
      const mockSigners = [makeSigner()]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSigners,
      })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.signers).toEqual(mockSigners)
      expect(result.current.error).toBeNull()
    })

    it('should handle an empty result', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.signers).toEqual([])
      expect(result.current.error).toBeNull()
    })

    it('should handle HTTP errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.error).toBe('HTTP 500')
      expect(result.current.signers).toEqual([])
    })

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.error).toBe('Network error')
      expect(result.current.signers).toEqual([])
    })

    it('should call fetch on mount with the correct endpoint', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => [] })

      renderHook(() => useSigners())

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/treasury/signers')
      })
    })
  })

  describe('addSigner', () => {
    it('should append a new signer returned by the server', async () => {
      const existing = [makeSigner({ address: 'GABC...SIGNER1' })]
      const added = makeSigner({ address: 'GDEF...SIGNER2', weight: 5 })

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => existing })
        .mockResolvedValueOnce({ ok: true, json: async () => added })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(1)
      })

      await act(async () => {
        await result.current.addSigner('GDEF...SIGNER2', 5)
      })

      expect(result.current.signers.length).toBe(2)
      expect(result.current.signers).toContainEqual(added)
    })

    it('should replace an existing signer when the address already exists', async () => {
      const existing = [makeSigner({ address: 'GABC...SIGNER1', weight: 10 })]
      const updated = makeSigner({ address: 'GABC...SIGNER1', weight: 25 })

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => existing })
        .mockResolvedValueOnce({ ok: true, json: async () => updated })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(1)
      })

      await act(async () => {
        await result.current.addSigner('GABC...SIGNER1', 25)
      })

      expect(result.current.signers.length).toBe(1)
      expect(result.current.signers[0]).toEqual(updated)
    })

    it('should propagate an error when the add request fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: false, status: 409 })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      let threwError = false
      try {
        await act(async () => {
          await result.current.addSigner('GABC...SIGNER1', 10)
        })
      } catch (e) {
        threwError = true
        expect((e as Error).message).toBe('HTTP 409')
      }

      expect(threwError).toBe(true)
      expect(result.current.signers).toEqual([])
    })
  })

  describe('removeSigner', () => {
    it('should remove the signer on success', async () => {
      const existing = [
        makeSigner({ address: 'GABC...SIGNER1' }),
        makeSigner({ address: 'GDEF...SIGNER2' }),
      ]

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => existing })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(2)
      })

      await act(async () => {
        await result.current.removeSigner('GABC...SIGNER1')
      })

      expect(result.current.signers.length).toBe(1)
      expect(result.current.signers[0].address).toBe('GDEF...SIGNER2')
    })

    it('should not modify signers when the remove request fails', async () => {
      const existing = [makeSigner({ address: 'GABC...SIGNER1' })]

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => existing })
        .mockResolvedValueOnce({ ok: false, status: 500 })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(1)
      })

      let threwError = false
      try {
        await act(async () => {
          await result.current.removeSigner('GABC...SIGNER1')
        })
      } catch (e) {
        threwError = true
        expect((e as Error).message).toBe('HTTP 500')
      }

      expect(threwError).toBe(true)
      expect(result.current.signers.length).toBe(1)
    })
  })

  describe('rotateSigners', () => {
    it('should call the rotate endpoint then refetch signers', async () => {
      const beforeRotate = [makeSigner({ address: 'GABC...SIGNER1' })]
      const afterRotate = [makeSigner({ address: 'GDEF...SIGNER2' })]

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => beforeRotate })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => afterRotate })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(1)
      })

      await act(async () => {
        await result.current.rotateSigners()
      })

      expect(mockFetch).toHaveBeenCalledWith('/api/treasury/rotate-signers', { method: 'POST' })
      expect(result.current.signers).toEqual(afterRotate)
    })

    it('should propagate an error and skip the refetch when rotation fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: false, status: 500 })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      const callCountBeforeRotate = mockFetch.mock.calls.length

      let threwError = false
      try {
        await act(async () => {
          await result.current.rotateSigners()
        })
      } catch (e) {
        threwError = true
        expect((e as Error).message).toBe('HTTP 500')
      }

      expect(threwError).toBe(true)
      expect(mockFetch.mock.calls.length).toBe(callCountBeforeRotate + 1)
    })
  })

  describe('refresh', () => {
    it('should manually trigger a fetch', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => [makeSigner()] })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers.length).toBe(1)
      })

      const initialCallCount = mockFetch.mock.calls.length

      await act(async () => {
        await result.current.refresh()
      })

      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount)
      expect(result.current.signers.length).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // invalidate – refetch-after-mutation
  // ---------------------------------------------------------------------------
  describe('invalidate', () => {
    it('should expose an invalidate function on the hook result', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => [] })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(typeof result.current.invalidate).toBe('function')
    })

    it('should re-fetch signers when invalidate is called', async () => {
      const initialSigners = [makeSigner({ address: 'GABC...SIGNER1' })]
      mockFetch.mockResolvedValue({ ok: true, json: async () => initialSigners })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => expect(result.current.signers.length).toBe(1))

      const callCountBefore = mockFetch.mock.calls.length

      await act(async () => {
        await result.current.invalidate()
      })

      expect(mockFetch.mock.calls.length).toBeGreaterThan(callCountBefore)
      expect(mockFetch).toHaveBeenCalledWith('/api/treasury/signers')
    })

    it('should update the signer list after calling invalidate following an external mutation', async () => {
      // Scenario: a rotate_signer transaction was submitted elsewhere in the
      // app.  The hook's stale list has SIGNER1; after invalidate the server
      // returns the rotated list with SIGNER2 only.
      const staleSigners = [makeSigner({ address: 'GABC...SIGNER1' })]
      const freshSigners = [makeSigner({ address: 'GDEF...SIGNER2' })]

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => staleSigners })  // initial fetch
        .mockResolvedValueOnce({ ok: true, json: async () => freshSigners })  // post-invalidate fetch

      const { result } = renderHook(() => useSigners())

      await waitFor(() => {
        expect(result.current.signers).toEqual(staleSigners)
      })

      await act(async () => {
        await result.current.invalidate()
      })

      expect(result.current.signers).toEqual(freshSigners)
    })

    it('should set loading to true during the invalidate re-fetch', async () => {
      let resolveSecondFetch!: (v: unknown) => void
      const secondFetchPromise = new Promise(res => { resolveSecondFetch = res })

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockReturnValueOnce(secondFetchPromise)

      const { result } = renderHook(() => useSigners())

      await waitFor(() => expect(result.current.loading).toBe(false))

      // Start invalidate but don't resolve yet.
      act(() => { void result.current.invalidate() })

      await waitFor(() => expect(result.current.loading).toBe(true))

      // Let the fetch resolve.
      resolveSecondFetch({ ok: true, json: async () => [] })
      await waitFor(() => expect(result.current.loading).toBe(false))
    })

    it('should handle errors during invalidate gracefully', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: false, status: 503 })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => {
        await result.current.invalidate()
      })

      expect(result.current.error).toBe('HTTP 503')
    })

    it('invalidate and refresh should both trigger a fetch of the same endpoint', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => [] })

      const { result } = renderHook(() => useSigners())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => { await result.current.invalidate() })
      await act(async () => { await result.current.refresh() })

      const signerCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === '/api/treasury/signers'
      )
      // initial + invalidate + refresh = at least 3
      expect(signerCalls.length).toBeGreaterThanOrEqual(3)
    })
  })
})
