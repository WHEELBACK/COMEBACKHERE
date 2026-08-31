import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import GraceWindowSettings from './GraceWindowSettings'

// Mock fetch so the component doesn't hang trying to hit /api/invoice/grace-window
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ grace_window_seconds: 86400 }),
      headers: { get: () => null },
    }),
  )
})

describe('GraceWindowSettings zero-value warning', () => {
  it('shows a non-blocking warning when the grace window is set to zero', async () => {
    render(<GraceWindowSettings />)

    // Wait for the initial fetch to complete so the input is enabled
    await screen.findByLabelText('New duration')

    const input = screen.getByLabelText('New duration')
    fireEvent.change(input, { target: { value: '0' } })

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(/zero/i)
  })

  it('does not show the zero warning for a positive value', async () => {
    render(<GraceWindowSettings />)

    await screen.findByLabelText('New duration')

    const input = screen.getByLabelText('New duration')
    fireEvent.change(input, { target: { value: '24' } })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the Save button enabled when value is zero (non-blocking warning)', async () => {
    render(<GraceWindowSettings />)

    await screen.findByLabelText('New duration')

    const input = screen.getByLabelText('New duration')
    fireEvent.change(input, { target: { value: '0' } })

    const saveBtn = screen.getByRole('button', { name: /save grace window/i })
    expect(saveBtn).not.toBeDisabled()
  })

  it('shows a blocking error for a non-integer value instead of the zero warning', async () => {
    render(<GraceWindowSettings />)

    await screen.findByLabelText('New duration')

    const input = screen.getByLabelText('New duration')
    fireEvent.change(input, { target: { value: '1.5' } })

    // Should show an error, not the zero warning
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/valid non-negative integer/i)).toBeInTheDocument()

    const saveBtn = screen.getByRole('button', { name: /save grace window/i })
    expect(saveBtn).toBeDisabled()
  })
})
