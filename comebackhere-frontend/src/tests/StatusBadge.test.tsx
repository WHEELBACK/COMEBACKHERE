import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../components/StatusBadge'
import { InvoiceStatus } from '../types'

describe('StatusBadge', () => {
  it('renders Pending badge', () => {
    render(<StatusBadge status={InvoiceStatus.Pending} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Pending')
    expect(badge).toHaveClass('badge--pending')
  })

  it('renders Paid badge', () => {
    render(<StatusBadge status={InvoiceStatus.Paid} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Paid')
    expect(badge).toHaveClass('badge--paid')
  })

  it('renders Expired badge', () => {
    render(<StatusBadge status={InvoiceStatus.Expired} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Expired')
    expect(badge).toHaveClass('badge--expired')
  })

  it('renders Cancelled badge', () => {
    render(<StatusBadge status={InvoiceStatus.Cancelled} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Cancelled')
    expect(badge).toHaveClass('badge--cancelled')
  })

  it('renders RefundRequested badge', () => {
    render(<StatusBadge status={InvoiceStatus.RefundRequested} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Refund Requested')
    expect(badge).toHaveClass('badge--refund-requested')
  })

  it('renders Released badge', () => {
    render(<StatusBadge status={InvoiceStatus.Released} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Released')
    expect(badge).toHaveClass('badge--released')
  })

  describe('OnHold variant (issue #258)', () => {
    it('renders OnHold badge with distinct css class', () => {
      render(<StatusBadge status={InvoiceStatus.OnHold} />)
      const badge = screen.getByRole('status')
      expect(badge).toHaveClass('badge--on-hold')
    })

    it('renders "On Hold" human-readable label, not "OnHold"', () => {
      render(<StatusBadge status={InvoiceStatus.OnHold} />)
      expect(screen.getByRole('status')).toHaveTextContent('On Hold')
    })

    it('OnHold and Pending use different CSS classes', () => {
      const { rerender } = render(<StatusBadge status={InvoiceStatus.Pending} />)
      const pendingClass = screen.getByRole('status').className

      rerender(<StatusBadge status={InvoiceStatus.OnHold} />)
      const onHoldClass = screen.getByRole('status').className

      expect(onHoldClass).not.toBe(pendingClass)
    })

    it('has an accessible aria-label for screen readers', () => {
      render(<StatusBadge status={InvoiceStatus.OnHold} />)
      expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Invoice status: On Hold')
    })
  })
})
