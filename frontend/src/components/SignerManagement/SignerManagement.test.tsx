import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import SignerManagement from './SignerManagement'
import * as useSignersModule from '../../hooks/useSigners'
import type { SignerInfo } from '../../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDR_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
const ADDR_B = 'GBVVJJPJZ3GR4VZVKNL4EOXTMQBQUXOUMGJXHWLZAGNNPPLZEXFQBVF'

function makeSigners(addresses: string[]): SignerInfo[] {
  return addresses.map((address, i) => ({ address, weight: i + 1 }))
}

function mockUseSigners(signers: SignerInfo[], overrides: Partial<ReturnType<typeof useSignersModule.useSigners>> = {}) {
  vi.spyOn(useSignersModule, 'useSigners').mockReturnValue({
    signers,
    loading: false,
    error: null,
    addSigner: vi.fn(),
    removeSigner: vi.fn(),
    rotateSigners: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignerManagement — identicons (issue #231)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders an identicon for each signer in the list', () => {
    mockUseSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)

    const identicons = screen.getAllByRole('img', { name: /Identicon for/ })
    expect(identicons).toHaveLength(2)
  })

  it('renders one identicon per unique address', () => {
    mockUseSigners(makeSigners([ADDR_A]))
    render(<SignerManagement />)

    expect(screen.getAllByRole('img', { name: /Identicon for/ })).toHaveLength(1)
  })

  it('each identicon has an accessible aria-label containing the shortened address', () => {
    mockUseSigners(makeSigners([ADDR_A]))
    render(<SignerManagement />)

    // GAAZI4... shortened → "GAAZI4...CCWN"
    const identicon = screen.getByRole('img', { name: /Identicon for GAAZI4/ })
    expect(identicon).toBeInTheDocument()
  })

  it('renders no identicons when signers list is empty', () => {
    mockUseSigners([])
    render(<SignerManagement />)

    expect(screen.queryAllByRole('img', { name: /Identicon for/ })).toHaveLength(0)
    expect(screen.getByText('No signers configured.')).toBeInTheDocument()
  })

  it('identicons are distinct SVGs for different addresses', () => {
    mockUseSigners(makeSigners([ADDR_A, ADDR_B]))
    render(<SignerManagement />)

    const identicons = screen.getAllByRole('img', { name: /Identicon for/ })
    expect(identicons).toHaveLength(2)

    // The inner SVG HTML should differ between the two addresses
    const svg1 = identicons[0].innerHTML
    const svg2 = identicons[1].innerHTML
    expect(svg1).not.toBe(svg2)
  })

  it('identicon is deterministic: same address always yields same SVG', () => {
    mockUseSigners(makeSigners([ADDR_A]))
    const { unmount } = render(<SignerManagement />)
    const svg1 = screen.getByRole('img', { name: /Identicon for/ }).innerHTML

    unmount()
    vi.restoreAllMocks()
    mockUseSigners(makeSigners([ADDR_A]))
    render(<SignerManagement />)
    const svg2 = screen.getByRole('img', { name: /Identicon for/ }).innerHTML

    expect(svg1).toBe(svg2)
  })
})
