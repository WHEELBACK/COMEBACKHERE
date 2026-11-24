import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ThresholdConfig from './ThresholdConfig'

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchRoute = {
  url: RegExp | string
  response: unknown
  status?: number
}

function setupFetch(routes: FetchRoute[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const route = routes.find(r =>
        typeof r.url === 'string' ? url.includes(r.url) : r.url.test(url),
      )
      const status = route?.status ?? 200
      const body = route ? JSON.stringify(route.response) : '{}'
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(route?.response ?? {}),
        text: () => Promise.resolve(body),
      })
    }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThresholdConfig — zero-signer edge case (issue #235)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows a placeholder warning instead of a broken/empty quorum preview when signers list is empty', async () => {
    setupFetch([
      { url: /threshold/, response: { threshold: 2 } },
      { url: /signers/, response: [] },         // ← zero signers
    ])

    render(<ThresholdConfig />)

    // Wait for the component to finish loading
    await waitFor(() => {
      expect(screen.queryByText(/Loading current value/i)).not.toBeInTheDocument()
    })

    // Enter a valid threshold value so quorum preview section becomes visible
    const input = screen.getByLabelText(/new threshold/i)
    fireEvent.change(input, { target: { value: '3' } })

    // The quorum preview section should appear with an informative message
    await waitFor(() => {
      expect(screen.getByText(/No signers registered/i)).toBeInTheDocument()
    })
  })

  it('does NOT show a NaN or divide-by-zero value when signers list is empty', async () => {
    setupFetch([
      { url: /threshold/, response: { threshold: 5 } },
      { url: /signers/, response: [] },
    ])

    render(<ThresholdConfig />)

    await waitFor(() => {
      expect(screen.queryByText(/Loading current value/i)).not.toBeInTheDocument()
    })

    const input = screen.getByLabelText(/new threshold/i)
    fireEvent.change(input, { target: { value: '5' } })

    // Allow any async state settling
    await waitFor(() => {
      const bodyText = document.body.textContent ?? ''
      expect(bodyText).not.toMatch(/NaN/)
      expect(bodyText).not.toMatch(/Infinity/)
      expect(bodyText).not.toMatch(/undefined/)
    })
  })

  it('shows quorum preview normally when signers are present', async () => {
    setupFetch([
      { url: /threshold/, response: { threshold: 2 } },
      {
        url: /signers/,
        response: [
          { address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', weight: 2 },
          { address: 'GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF', weight: 1 },
        ],
      },
    ])

    render(<ThresholdConfig />)

    await waitFor(() => {
      expect(screen.queryByText(/Loading current value/i)).not.toBeInTheDocument()
    })

    const input = screen.getByLabelText(/new threshold/i)
    fireEvent.change(input, { target: { value: '2' } })

    await waitFor(() => {
      expect(screen.getByText(/Quorum Preview/i)).toBeInTheDocument()
      expect(screen.getByText(/Required signers:/i)).toBeInTheDocument()
    })

    // No "no signers" warning when signers are actually present
    expect(screen.queryByText(/No signers registered/i)).not.toBeInTheDocument()
  })

  it('shows infeasible threshold warning when threshold exceeds total signer weight', async () => {
    setupFetch([
      { url: /threshold/, response: { threshold: 1 } },
      {
        url: /signers/,
        response: [
          { address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', weight: 1 },
        ],
      },
    ])

    render(<ThresholdConfig />)

    await waitFor(() => {
      expect(screen.queryByText(/Loading current value/i)).not.toBeInTheDocument()
    })

    const input = screen.getByLabelText(/new threshold/i)
    fireEvent.change(input, { target: { value: '999' } })

    await waitFor(() => {
      expect(screen.getByText(/unreachable/i)).toBeInTheDocument()
    })
  })
})
