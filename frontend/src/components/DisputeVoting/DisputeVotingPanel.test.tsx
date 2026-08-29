import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import DisputeVotingPanel from './DisputeVotingPanel'
import * as useDisputesModule from '../../hooks/useDisputes'
import type { Dispute } from '../../types/dispute'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_DISPUTE: Dispute = {
  settlement_id: 42,
  claimant_weight: 3,
  counterparty_weight: 2,
  resolution_weight: 5,
  threshold: 5,
  outcome: null,
  votes: [],
}

function mockUseDisputes(disputes: Dispute[]) {
  vi.spyOn(useDisputesModule, 'useDisputes').mockReturnValue({
    disputes,
    loading: false,
    error: null,
    voteDispute: vi.fn(),
    refresh: vi.fn(),
    lastUpdated: new Date('2025-01-01T12:00:00Z'),
    weightChanged: false,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DisputeVotingPanel — finalized/disabled state (issue #230)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders vote buttons when a dispute is open (outcome is null)', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: null }])
    render(<DisputeVotingPanel />)

    expect(screen.getByRole('button', { name: /Vote in favor of claimant/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Vote in favor of counterparty/i })).toBeInTheDocument()
  })

  it('does NOT render vote buttons when a dispute is finalized', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedClaimant' }])
    render(<DisputeVotingPanel />)

    expect(screen.queryByRole('button', { name: /Vote Claimant/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Vote Counterparty/i })).not.toBeInTheDocument()
  })

  it('shows "Outcome finalized" notice when dispute is resolved', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedClaimant' }])
    render(<DisputeVotingPanel />)

    expect(screen.getByText(/Outcome finalized/i)).toBeInTheDocument()
  })

  it('shows the outcome badge with the winner label when finalized (claimant)', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedClaimant' }])
    render(<DisputeVotingPanel />)

    expect(screen.getByText(/Resolved: Claimant/i)).toBeInTheDocument()
  })

  it('shows the outcome badge with the winner label when finalized (counterparty)', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedCounterparty' }])
    render(<DisputeVotingPanel />)

    expect(screen.getByText(/Resolved: Counterparty/i)).toBeInTheDocument()
  })

  it('finalized notice has role=status for screen reader accessibility', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedCounterparty' }])
    render(<DisputeVotingPanel />)

    expect(screen.getByRole('status', { name: '' })).toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toMatch(/Outcome finalized/i)
  })

  it('dispute card gets dispute-card--finalized class when outcome is set', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: 'ResolvedClaimant' }])
    const { container } = render(<DisputeVotingPanel />)

    const finalizedCard = container.querySelector('.dispute-card--finalized')
    expect(finalizedCard).toBeInTheDocument()
  })

  it('open disputes do NOT get the dispute-card--finalized class', () => {
    mockUseDisputes([{ ...BASE_DISPUTE, outcome: null }])
    const { container } = render(<DisputeVotingPanel />)

    expect(container.querySelector('.dispute-card--finalized')).not.toBeInTheDocument()
  })

  it('a mix of open and finalized disputes renders correctly', () => {
    mockUseDisputes([
      { ...BASE_DISPUTE, settlement_id: 1, outcome: null },
      { ...BASE_DISPUTE, settlement_id: 2, outcome: 'ResolvedCounterparty' },
    ])
    render(<DisputeVotingPanel />)

    // Open dispute has vote buttons (aria-label references the settlement id)
    expect(screen.getAllByRole('button', { name: /Vote in favor of claimant/i })).toHaveLength(1)
    // Finalized dispute has no vote buttons but shows notice
    expect(screen.getAllByText(/Outcome finalized/i)).toHaveLength(1)
  })
})
