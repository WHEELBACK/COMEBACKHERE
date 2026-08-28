import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmptyState, EmptyStateIcon } from './EmptyState'

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(
      <EmptyState
        title="Nothing here"
        description="No items to display"
      />
    )
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('No items to display')).toBeInTheDocument()
  })

  it('renders the icon when provided', () => {
    render(
      <EmptyState
        icon={<EmptyStateIcon />}
        title="Empty"
      />
    )
    expect(document.querySelector('.empty-state__icon')).toBeInTheDocument()
  })

  it('renders an action button and calls onClick when clicked', () => {
    const handleClick = vi.fn()
    render(
      <EmptyState
        title="No Settlements"
        action={{ label: 'Propose a Settlement', onClick: handleClick }}
      />
    )

    const btn = screen.getByRole('button', { name: 'Propose a Settlement' })
    expect(btn).toBeInTheDocument()

    fireEvent.click(btn)
    expect(handleClick).toHaveBeenCalledOnce()
  })

  it('renders an anchor link when href is supplied', () => {
    render(
      <EmptyState
        title="No Settlements"
        action={{ label: 'Go to Settlements', href: '/settlements' }}
      />
    )

    const link = screen.getByRole('link', { name: 'Go to Settlements' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/settlements')
  })

  it('does not render a CTA when action is omitted', () => {
    render(<EmptyState title="Nothing" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
