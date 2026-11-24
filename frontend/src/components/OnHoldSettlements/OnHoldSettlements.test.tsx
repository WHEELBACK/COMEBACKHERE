import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OnHoldSettlements from './OnHoldSettlements'
import type { Settlement } from '../../types'

const MOCK_SETTLEMENTS: Settlement[] = [
  {
    id: 1,
    merchant_address: 'GABC123456789ABCDEF',
    amount: '10000000',
    approvals: [],
    approval_weight: 0,
    status: 'OnHold',
    hold_reason: 'ComplianceReview',
  },
  {
    id: 2,
    merchant_address: 'GXYZ987654321XYZUVW',
    amount: '20000000',
    approvals: [],
    approval_weight: 0,
    status: 'OnHold',
    hold_reason: 'FraudCheck',
  },
  {
    id: 3,
    merchant_address: 'GPQR555000555PQRSTV',
    amount: '5000000',
    approvals: [],
    approval_weight: 0,
    status: 'OnHold',
    hold_reason: 'KycPending',
  },
]

function makeFetchMock(settlements: Settlement[]) {
  return vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (!options || options.method !== 'POST') {
      // GET on-hold list
      return Promise.resolve({
        ok: true,
        json: async () => settlements,
        headers: { get: () => String(settlements.length) },
      })
    }

    // POST release-hold — parse the body to return matching updated settlement
    const body = JSON.parse(options.body as string) as { settlement_id: number }
    const match = settlements.find(s => s.id === body.settlement_id)
    if (!match) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ ...match, status: 'Executed' }),
    })
  })
}

describe('OnHoldSettlements bulk select and release', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetchMock(MOCK_SETTLEMENTS))
  })

  it('renders a checkbox for each row and a select-all checkbox', async () => {
    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select settlement #1')

    expect(screen.getByLabelText('Select settlement #1')).toBeInTheDocument()
    expect(screen.getByLabelText('Select settlement #2')).toBeInTheDocument()
    expect(screen.getByLabelText('Select settlement #3')).toBeInTheDocument()
    expect(screen.getByLabelText('Select all settlements on this page')).toBeInTheDocument()
  })

  it('shows a bulk release toolbar after selecting multiple rows', async () => {
    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select settlement #1')

    fireEvent.click(screen.getByLabelText('Select settlement #1'))
    fireEvent.click(screen.getByLabelText('Select settlement #2'))

    expect(await screen.findByText(/2 settlements selected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bulk release 2/i })).toBeInTheDocument()
  })

  it('shows a confirmation modal before submitting the bulk release', async () => {
    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select settlement #1')

    fireEvent.click(screen.getByLabelText('Select settlement #1'))
    fireEvent.click(screen.getByLabelText('Select settlement #2'))

    fireEvent.click(screen.getByRole('button', { name: /bulk release 2/i }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/confirm bulk release/i)).toBeInTheDocument()
    // The count is in a <strong> element — use container text match
    expect(screen.getByRole('dialog')).toHaveTextContent(/2.*on-hold settlement/i)
  })

  it('cancelling the confirmation modal keeps the rows selected', async () => {
    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select settlement #1')

    fireEvent.click(screen.getByLabelText('Select settlement #1'))

    fireEvent.click(screen.getByRole('button', { name: /bulk release 1/i }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: /cancel bulk release/i }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/1 settlement selected/i)).toBeInTheDocument()
  })

  it('confirming bulk release calls the API for each selected settlement', async () => {
    const fetchMock = makeFetchMock(MOCK_SETTLEMENTS)
    vi.stubGlobal('fetch', fetchMock)

    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select settlement #1')

    fireEvent.click(screen.getByLabelText('Select settlement #1'))
    fireEvent.click(screen.getByLabelText('Select settlement #2'))

    fireEvent.click(screen.getByRole('button', { name: /bulk release 2/i }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: /confirm bulk release/i }))

    await waitFor(() => {
      expect(screen.getByText(/2 settlements released/i)).toBeInTheDocument()
    })

    // Should have posted release-hold for settlement #1 and #2
    const postCalls = (fetchMock.mock.calls as [string, RequestInit | undefined][])
      .filter(([, opts]) => opts?.method === 'POST')
    expect(postCalls).toHaveLength(2)
    const postedIds = postCalls.map(([, opts]) =>
      (JSON.parse(opts!.body as string) as { settlement_id: number }).settlement_id,
    )
    expect(postedIds).toContain(1)
    expect(postedIds).toContain(2)
  })

  it('select-all checkbox selects all rows on the current page', async () => {
    render(<OnHoldSettlements />)

    await screen.findByLabelText('Select all settlements on this page')

    fireEvent.click(screen.getByLabelText('Select all settlements on this page'))

    expect(await screen.findByText(/3 settlements selected/i)).toBeInTheDocument()
  })
})
