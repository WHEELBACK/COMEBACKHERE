/**
 * Tests for NetworkSelector confirmation dialog (Issue #1).
 *
 * Verifies that:
 *  - switching networks without dirty form state switches immediately.
 *  - switching networks with dirty form state shows a confirmation prompt.
 *  - confirming the switch actually changes the network.
 *  - cancelling the switch leaves the network unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import NetworkSelector from "./NetworkSelector";

// ---- Mock useNetwork -------------------------------------------------------
const mockSetNetwork = vi.fn();
let currentNetwork: "testnet" | "mainnet" = "testnet";

vi.mock("../../hooks/useNetwork", () => ({
  useNetwork: () => ({
    network: currentNetwork,
    setNetwork: mockSetNetwork,
    isMainnet: currentNetwork === "mainnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    hasNetworkMismatch: false,
    walletPassphrase: null,
    walletNetwork: null,
    isCheckingWallet: false,
  }),
}));

// ---- Helpers ---------------------------------------------------------------

function registerDirtyForm(key = "test-form") {
  if (!window.__networkSelectorDirtyForms) {
    window.__networkSelectorDirtyForms = new Set();
  }
  window.__networkSelectorDirtyForms.add(key);
}

function clearDirtyForms() {
  window.__networkSelectorDirtyForms?.clear();
}

// ---- Tests -----------------------------------------------------------------

describe("NetworkSelector", () => {
  beforeEach(() => {
    currentNetwork = "testnet";
    mockSetNetwork.mockClear();
    clearDirtyForms();
  });

  afterEach(() => {
    clearDirtyForms();
  });

  it("renders the network selector with the current network selected", () => {
    render(<NetworkSelector />);
    const select = screen.getByRole("combobox", { name: /select network/i });
    expect(select).toHaveValue("testnet");
  });

  it("switches network immediately when no dirty forms are registered", () => {
    render(<NetworkSelector />);
    const select = screen.getByRole("combobox", { name: /select network/i });
    fireEvent.change(select, { target: { value: "mainnet" } });
    // Dialog should NOT appear
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Network should switch directly
    expect(mockSetNetwork).toHaveBeenCalledWith("mainnet");
  });

  it("shows the confirmation dialog when switching with dirty form state", () => {
    registerDirtyForm("settlement-proposal");
    render(<NetworkSelector />);
    const select = screen.getByRole("combobox", { name: /select network/i });
    fireEvent.change(select, { target: { value: "mainnet" } });

    // Dialog must be visible
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    // The dialog body mentions the pending network name
    expect(screen.getByText(/switching to/i)).toBeInTheDocument();

    // Network must NOT have switched yet
    expect(mockSetNetwork).not.toHaveBeenCalled();
  });

  it("confirms the switch when the user clicks 'Switch network'", () => {
    registerDirtyForm("settlement-proposal");
    render(<NetworkSelector />);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "mainnet" },
    });

    // Confirm
    fireEvent.click(screen.getByTestId("ns-confirm-switch"));

    expect(mockSetNetwork).toHaveBeenCalledWith("mainnet");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels the switch when the user clicks 'Keep editing'", () => {
    registerDirtyForm("settlement-proposal");
    render(<NetworkSelector />);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "mainnet" },
    });

    // Cancel
    fireEvent.click(screen.getByTestId("ns-cancel-switch"));

    expect(mockSetNetwork).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the mainnet warning when on mainnet", () => {
    currentNetwork = "mainnet";
    render(<NetworkSelector />);
    expect(screen.getByRole("alert")).toHaveTextContent(/mainnet/i);
  });

  it("does not show the mainnet warning when on testnet", () => {
    currentNetwork = "testnet";
    render(<NetworkSelector />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
