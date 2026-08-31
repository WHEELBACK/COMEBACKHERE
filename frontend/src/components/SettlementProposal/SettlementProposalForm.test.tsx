import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettlementProposalForm from './SettlementProposalForm'

/**
 * Allowlisted token addresses and symbols as defined in SettlementProposalForm.tsx.
 * These mirror the TREASURY_ALLOWLIST constant so that if it changes the tests fail.
 */
const ALLOWLISTED_SYMBOLS = ['USDC', 'XLM']
const ALLOWLISTED_ADDRESSES = [
  'CDLZFC3SYJYDZT7K3VJIVSTJ3NMX3MKGIFXGXNJ3S4BJW3J3FY5PXYZQ',
  'CB3Q6Z3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3T3',
]

/** A Stellar address that is NOT on the allowlist */
const NON_ALLOWLISTED_ADDRESS = 'GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234'

describe('SettlementProposalForm token allowlist enforcement', () => {
  it('renders exactly the allowlisted tokens as select options', () => {
    render(<SettlementProposalForm />)

    const select = screen.getByRole('combobox', { name: /token/i })

    // Collect values of all real (non-placeholder) options
    const optionValues = Array.from(select.querySelectorAll('option'))
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== '') // exclude the placeholder "-- Select token --"

    expect(optionValues).toHaveLength(ALLOWLISTED_ADDRESSES.length)
    for (const addr of ALLOWLISTED_ADDRESSES) {
      expect(optionValues).toContain(addr)
    }
  })

  it('shows each allowlisted token symbol in the select', () => {
    render(<SettlementProposalForm />)

    for (const symbol of ALLOWLISTED_SYMBOLS) {
      // The option label contains the symbol
      expect(screen.getByRole('option', { name: new RegExp(symbol) })).toBeInTheDocument()
    }
  })

  it('does not offer a non-allowlisted token address as an option', () => {
    render(<SettlementProposalForm />)

    const select = screen.getByRole('combobox', { name: /token/i })
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    )

    expect(optionValues).not.toContain(NON_ALLOWLISTED_ADDRESS)
  })

  it('selecting a non-empty token value updates the combobox', () => {
    render(<SettlementProposalForm />)

    const select = screen.getByRole('combobox', { name: /token/i })

    fireEvent.change(select, { target: { value: ALLOWLISTED_ADDRESSES[0] } })

    expect((select as HTMLSelectElement).value).toBe(ALLOWLISTED_ADDRESSES[0])
  })

  it('shows an error when submitting without selecting a token', async () => {
    render(<SettlementProposalForm />)

    // Fill in a valid amount and address so the only missing field is token
    const validAddress = 'G' + 'A'.repeat(55) // 56-char address starting with G
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/merchant address/i), {
      target: { value: validAddress },
    })

    fireEvent.click(screen.getByRole('button', { name: /propose settlement/i }))

    await waitFor(() => {
      expect(screen.getByText(/please select a token/i)).toBeInTheDocument()
    })
  })

  it('does not show a token error when a valid allowlisted token is selected', async () => {
    render(<SettlementProposalForm />)

    const validAddress = 'G' + 'A'.repeat(55)
    fireEvent.change(screen.getByRole('combobox', { name: /token/i }), {
      target: { value: ALLOWLISTED_ADDRESSES[0] },
    })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/merchant address/i), {
      target: { value: validAddress },
    })

    fireEvent.click(screen.getByRole('button', { name: /propose settlement/i }))

    // The "please select a token" error should NOT appear
    await waitFor(() => {
      expect(screen.queryByText(/please select a token/i)).not.toBeInTheDocument()
    })
  })
})
