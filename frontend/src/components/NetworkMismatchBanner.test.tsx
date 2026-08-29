import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import NetworkMismatchBanner from "./NetworkMismatchBanner";

// ---------------------------------------------------------------------------
// Mock useNetwork so tests control the mismatch state independently of the
// real Freighter / localStorage logic inside the hook.
// ---------------------------------------------------------------------------
const mockUseNetwork = vi.fn();

vi.mock("../hooks/useNetwork", () => ({
  useNetwork: () => mockUseNetwork(),
}));

// Storage key used by the component (must match the constant in the source).
const DISMISS_STORAGE_KEY = "comebackhere-network-mismatch-dismissed";

function matchedNetworkState() {
  return {
    hasNetworkMismatch: false,
    network: "testnet",
    walletNetwork: "testnet",
    isCheckingWallet: false,
  };
}

function mismatchedNetworkState() {
  return {
    hasNetworkMismatch: true,
    network: "testnet",
    walletNetwork: "mainnet",
    isCheckingWallet: false,
  };
}

function checkingWalletState() {
  return {
    hasNetworkMismatch: false,
    network: "testnet",
    walletNetwork: null,
    isCheckingWallet: true,
  };
}

describe("NetworkMismatchBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  describe("visibility", () => {
    it("renders nothing when there is no network mismatch", () => {
      mockUseNetwork.mockReturnValue(matchedNetworkState());
      const { container } = render(<NetworkMismatchBanner />);
      expect(container.firstChild).toBeNull();
    });

    it("renders nothing while the wallet network is still being checked", () => {
      mockUseNetwork.mockReturnValue(checkingWalletState());
      const { container } = render(<NetworkMismatchBanner />);
      expect(container.firstChild).toBeNull();
    });

    it("renders the banner when there is a network mismatch", () => {
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      render(<NetworkMismatchBanner />);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("Network Mismatch")).toBeInTheDocument();
    });

    it("shows app and wallet network names in the banner", () => {
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      render(<NetworkMismatchBanner />);
      // The component renders each network name twice (in prose + in the
      // details grid), so use getAllByText.
      expect(screen.getAllByText("testnet").length).toBeGreaterThan(0);
      expect(screen.getAllByText("mainnet").length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Dismiss button
  // -------------------------------------------------------------------------
  describe("dismiss button", () => {
    it("renders a dismiss button when the banner is visible", () => {
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      render(<NetworkMismatchBanner />);
      expect(
        screen.getByRole("button", { name: /dismiss network mismatch banner/i })
      ).toBeInTheDocument();
    });

    it("hides the banner immediately when the dismiss button is clicked", () => {
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      render(<NetworkMismatchBanner />);

      fireEvent.click(
        screen.getByRole("button", { name: /dismiss network mismatch banner/i })
      );

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Dismiss persistence via localStorage
  // -------------------------------------------------------------------------
  describe("dismiss persistence", () => {
    it("persists the dismissed state to localStorage on dismiss", () => {
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      render(<NetworkMismatchBanner />);

      fireEvent.click(
        screen.getByRole("button", { name: /dismiss network mismatch banner/i })
      );

      expect(localStorage.getItem(DISMISS_STORAGE_KEY)).toBe("true");
    });

    it("does not show the banner on remount when already dismissed in localStorage", () => {
      // Simulate a previously dismissed state (e.g. from a prior page load).
      localStorage.setItem(DISMISS_STORAGE_KEY, "true");

      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      const { container } = render(<NetworkMismatchBanner />);

      expect(container.firstChild).toBeNull();
    });

    it("uses the storage key that matches the network storage key constant", () => {
      // The dismissed key should be distinct from the network selection key so
      // clearing the dismissed flag cannot accidentally affect network selection.
      expect(DISMISS_STORAGE_KEY).not.toBe("comebackhere-network");
    });

    it("clears the dismissed flag from localStorage when the mismatch resolves", () => {
      // Start dismissed.
      localStorage.setItem(DISMISS_STORAGE_KEY, "true");

      // First render: mismatch is present but already dismissed.
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      const { rerender } = render(<NetworkMismatchBanner />);

      // Simulate the mismatch resolving (user fixed their wallet).
      mockUseNetwork.mockReturnValue(matchedNetworkState());
      rerender(<NetworkMismatchBanner />);

      expect(localStorage.getItem(DISMISS_STORAGE_KEY)).toBeNull();
    });

    it("re-shows the banner after the mismatch resolves and then reappears", () => {
      // 1. Mismatch present → user dismisses.
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      const { rerender } = render(<NetworkMismatchBanner />);

      fireEvent.click(
        screen.getByRole("button", { name: /dismiss network mismatch banner/i })
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // 2. Mismatch resolves (clears dismissed flag).
      mockUseNetwork.mockReturnValue(matchedNetworkState());
      rerender(<NetworkMismatchBanner />);
      expect(localStorage.getItem(DISMISS_STORAGE_KEY)).toBeNull();

      // 3. Mismatch returns → banner should be visible again.
      mockUseNetwork.mockReturnValue(mismatchedNetworkState());
      rerender(<NetworkMismatchBanner />);

      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
