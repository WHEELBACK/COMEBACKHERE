import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ApiKeyManagement } from "../components/ApiKeyManagement"

const MERCHANT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ApiKeyManagement — Authorization and Initial States", () => {
  it("renders authorization warning and disables key generation when wallet is not connected", () => {
    render(<ApiKeyManagement merchantAddress={null} />)
    expect(screen.getByTestId("auth-required-warning")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Generate new API key/i })).toBeDisabled()
  })

  it("loads and displays existing API key metadata when merchant is connected", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "test-key-uuid-1",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: null,
          last_used_at: "2026-10-21T00:15:00.000Z",
          is_active: true,
        },
      ])
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    await waitFor(() => {
      expect(screen.getByTestId("key-row-test-key-uuid-1")).toBeInTheDocument()
    })

    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByTestId("last-used-test-key-uuid-1")).not.toHaveTextContent("Never used")
    expect(screen.queryByTestId("secret-key-banner")).not.toBeInTheDocument()
  })

  it("displays 'Never used' for keys with no last_used_at timestamp", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "test-key-uuid-2",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: null,
          last_used_at: null,
          is_active: true,
        },
      ])
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    await waitFor(() => {
      expect(screen.getByTestId("key-row-test-key-uuid-2")).toBeInTheDocument()
    })

    expect(screen.getByTestId("last-used-test-key-uuid-2")).toHaveTextContent("Never used")
  })
})

describe("ApiKeyManagement — Secret Shown ONLY at Creation", () => {
  it("generates an API key, reveals secret, and hides secret upon dismissal", async () => {
    const user = userEvent.setup()

    // 1st call: initial list (empty)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []))

    // 2nd call: POST /api/merchant-keys
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        key_id: "created-key-1234",
        merchant_address: MERCHANT,
        api_key: "ch_super_secret_plaintext_key",
        created_at: "2026-10-21T00:00:00.000Z",
        is_active: true,
      })
    )

    // 3rd call: reload list after create
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "created-key-1234",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: null,
          last_used_at: null,
          is_active: true,
        },
      ])
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    const createBtn = await screen.findByRole("button", { name: /Generate new API key/i })
    await user.click(createBtn)

    // Secret is displayed in banner
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-banner")).toBeInTheDocument()
    })
    expect(screen.getByTestId("plaintext-api-key")).toHaveTextContent("ch_super_secret_plaintext_key")

    // Dismiss secret
    const dismissBtn = screen.getByRole("button", { name: /Dismiss and hide secret key/i })
    await user.click(dismissBtn)

    // Banner is gone; secret is nowhere in the DOM
    expect(screen.queryByTestId("secret-key-banner")).not.toBeInTheDocument()
    expect(screen.queryByText("ch_super_secret_plaintext_key")).not.toBeInTheDocument()
  })
})

describe("ApiKeyManagement — Rotation & Revocation Flows", () => {
  it("opens rotation confirmation and executes rotation", async () => {
    const user = userEvent.setup()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "active-key-1",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: null,
          last_used_at: null,
          is_active: true,
        },
      ])
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    const rotateBtn = await screen.findByRole("button", { name: /Rotate API key/i })
    await user.click(rotateBtn)

    // Confirmation modal should be visible
    expect(screen.getByText(/Rotate Merchant API Key/i)).toBeInTheDocument()

    // Mock rotate response
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        key_id: "rotated-key-2",
        merchant_address: MERCHANT,
        api_key: "ch_rotated_secret_key",
        created_at: "2026-10-21T00:10:00.000Z",
        rotated_at: "2026-10-21T00:10:00.000Z",
        is_active: true,
      })
    )

    // Mock subsequent list response
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "rotated-key-2",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:10:00.000Z",
          revoked_at: null,
          last_used_at: null,
          is_active: true,
        },
        {
          key_id: "active-key-1",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: "2026-10-21T00:10:00.000Z",
          last_used_at: null,
          is_active: false,
        },
      ])
    )

    const confirmRotateBtn = screen.getByTestId("confirm-rotate-button")
    await user.click(confirmRotateBtn)

    await waitFor(() => {
      expect(screen.getByTestId("plaintext-api-key")).toHaveTextContent("ch_rotated_secret_key")
    })
  })

  it("handles revocation confirmation and updates UI", async () => {
    const user = userEvent.setup()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "key-to-revoke-1234",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: null,
          last_used_at: null,
          is_active: true,
        },
      ])
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    const revokeBtn = await screen.findByTestId("revoke-btn-key-to-revoke-1234")
    await user.click(revokeBtn)

    expect(screen.getByText(/Revoke API Key/i)).toBeInTheDocument()

    // Mock delete 204
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    // Mock subsequent list response showing revoked
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          key_id: "key-to-revoke-1234",
          merchant_address: MERCHANT,
          created_at: "2026-10-21T00:00:00.000Z",
          revoked_at: "2026-10-21T00:10:00.000Z",
          last_used_at: null,
          is_active: false,
        },
      ])
    )

    const confirmRevokeBtn = screen.getByTestId("confirm-revoke-button")
    await user.click(confirmRevokeBtn)

    await waitFor(() => {
      expect(screen.getByText("Revoked")).toBeInTheDocument()
    })
  })

  it("displays server error banner when API call fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: "Database connection failed" })
    )

    render(<ApiKeyManagement merchantAddress={MERCHANT} />)

    await waitFor(() => {
      expect(screen.getByTestId("api-key-error")).toHaveTextContent("Database connection failed")
    })
  })
})
