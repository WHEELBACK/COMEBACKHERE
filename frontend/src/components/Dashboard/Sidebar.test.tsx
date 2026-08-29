/**
 * Tests for Sidebar role-based visibility (Issue #3).
 *
 * Admin-only links (Treasury, Signers, Settings) must be hidden for wallets
 * that are not registered signers, and visible for wallets that are.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "./Sidebar";

// ---- Mock useSigners -------------------------------------------------------

const mockSigners = [
  { address: "GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", weight: 1 },
  { address: "GADMIN2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", weight: 1 },
];

let signersLoading = false;

vi.mock("../../hooks/useSigners", () => ({
  useSigners: () => ({
    signers: mockSigners,
    loading: signersLoading,
    error: null,
    addSigner: vi.fn(),
    removeSigner: vi.fn(),
    rotateSigners: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// ---- Helpers ---------------------------------------------------------------

function renderSidebar(connectedAddress?: string | null) {
  render(
    <MemoryRouter>
      <Sidebar connectedAddress={connectedAddress} />
    </MemoryRouter>,
  );
}

// ---- Tests -----------------------------------------------------------------

describe("Sidebar — role-based visibility", () => {
  beforeEach(() => {
    signersLoading = false;
  });

  // Public links always visible
  const publicLinks = ["Invoices", "Settlements", "On-Hold", "Disputes"];
  // Admin-only links
  const adminLinks = ["Treasury", "Signers", "Settings"];

  it("shows public links for a non-admin wallet", () => {
    renderSidebar("GUSER1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    for (const label of publicLinks) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("hides admin-only links for a non-admin wallet", () => {
    renderSidebar("GUSER1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    for (const label of adminLinks) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("hides admin-only links when no wallet is connected", () => {
    renderSidebar(null);
    for (const label of adminLinks) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("hides admin-only links when connectedAddress is undefined", () => {
    renderSidebar(undefined);
    for (const label of adminLinks) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("shows all links for a registered signer", () => {
    renderSidebar("GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    for (const label of [...publicLinks, ...adminLinks]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("hides admin-only links while the signer list is still loading (fail-closed)", () => {
    signersLoading = true;
    renderSidebar("GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    for (const label of adminLinks) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // Public links still appear
    for (const label of publicLinks) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("performs case-insensitive address comparison", () => {
    // Provide the address in lowercase; the signer list uses uppercase
    const lower = "GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX".toLowerCase();
    renderSidebar(lower);
    for (const label of adminLinks) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
