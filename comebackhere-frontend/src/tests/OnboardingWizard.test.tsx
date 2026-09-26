/**
 * Tests for OnboardingWizard, ported from the legacy frontend/.
 *
 * Verifies that:
 *  - a Back button is present on every step after the first.
 *  - navigating back and then forward again preserves data entered on later steps.
 *  - localStorage state is preserved across back/forward navigation.
 *  - completed-step badges remain visible when the user returns to a step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { renderHook, act } from "@testing-library/react";
import OnboardingWizard, { useOnboarding } from "../components/OnboardingWizard";

type WizardProps = ComponentProps<typeof OnboardingWizard>;

const STORAGE_KEY = "comebackhere_onboarding_state";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard(onComplete = vi.fn(), props: Partial<WizardProps> = {}) {
  return render(
    <OnboardingWizard onComplete={onComplete} onConnectWallet={vi.fn()} {...props} />,
  );
}

/**
 * Re-query the wizard-body element each time to avoid stale references after
 * state updates re-render the component.
 */
function wizardBody(): HTMLElement {
  return document.querySelector(".wizard-body") as HTMLElement;
}

function clickBack() {
  // The Back button's aria-label contains the word "back", so use
  // getAllByRole and pick the one whose text content is "Back".
  const backButtons = screen.queryAllByRole("button");
  const btn = backButtons.find((b) => b.textContent?.trim() === "Back");
  if (!btn) throw new Error("Back button not found");
  fireEvent.click(btn);
}

function clickNext() {
  // The Next button's aria-label contains "Proceed to step …"
  const nextBtn = screen.getByRole("button", { name: /proceed to step/i });
  fireEvent.click(nextBtn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OnboardingWizard — back navigation", () => {
  it("does not show a Back button on step 1 (first step)", () => {
    renderWizard();
    const allButtons = screen.queryAllByRole("button");
    const backBtn = allButtons.find((b) => b.textContent?.trim() === "Back");
    expect(backBtn).toBeUndefined();
  });

  it("shows the Back button on step 2 (verify) and navigates back to step 1", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentStep: 1,
        walletAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        verified: false,
        invoiceAmount: "",
        invoiceRecipient: "",
        invoiceCreated: false,
      }),
    );

    renderWizard();

    // Should be on step 2 (verify): h3 in wizard-body reads "Verify Address"
    const stepHeading = within(wizardBody()).getByRole("heading", { level: 3 });
    expect(stepHeading).toHaveTextContent("Verify Address");

    // Back button must exist
    const allButtons = screen.queryAllByRole("button");
    const backBtn = allButtons.find((b) => b.textContent?.trim() === "Back");
    expect(backBtn).toBeDefined();

    // Click Back → should return to step 1 (wallet)
    clickBack();
    const stepHeadingAfter = within(wizardBody()).getByRole("heading", { level: 3 });
    expect(stepHeadingAfter).toHaveTextContent("Connect Wallet");

    // No Back button on first step
    const allButtonsAfter = screen.queryAllByRole("button");
    expect(allButtonsAfter.find((b) => b.textContent?.trim() === "Back")).toBeUndefined();
  });

  it("preserves invoice data when navigating back from step 4 to step 3 and forward again", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentStep: 3, // dashboard step
        walletAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        verified: true,
        invoiceAmount: "250",
        invoiceRecipient: "customer@example.com",
        invoiceCreated: true,
      }),
    );

    renderWizard();

    // On step 4 (dashboard)
    expect(within(wizardBody()).getByText(/you're all set/i)).toBeInTheDocument();

    // Navigate back to step 3 (invoice)
    clickBack();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Create Invoice");

    // Invoice data should still be present
    expect(screen.getByPlaceholderText("100.00")).toHaveValue(250);
    expect(screen.getByDisplayValue("customer@example.com")).toBeInTheDocument();
    expect(within(wizardBody()).getByText(/invoice created/i)).toBeInTheDocument();

    // Navigate back to step 2 (verify)
    clickBack();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Verify Address");
    expect(within(wizardBody()).getByText(/address verified/i)).toBeInTheDocument();

    // Navigate forward to step 3 (invoice) via Next button
    clickNext();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Create Invoice");

    // Invoice data must still be intact after round-trip
    expect(screen.getByPlaceholderText("100.00")).toHaveValue(250);
    expect(screen.getByDisplayValue("customer@example.com")).toBeInTheDocument();
    expect(within(wizardBody()).getByText(/invoice created/i)).toBeInTheDocument();
  });

  it("preserves wallet address when navigating back from verify to wallet and forward again", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentStep: 1,
        walletAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        verified: false,
        invoiceAmount: "",
        invoiceRecipient: "",
        invoiceCreated: false,
      }),
    );

    renderWizard();

    // On verify step — go back to wallet step
    clickBack();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Connect Wallet");

    // Wallet address should still be shown (already connected indicator)
    expect(
      screen.getByText("GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
    ).toBeInTheDocument();

    // Go forward to verify again via Next
    clickNext();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Verify Address");

    // Address should still be populated in the read-only input
    expect(
      screen.getByDisplayValue("GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
    ).toBeInTheDocument();
  });

  it("shows Back button on the last (dashboard) step", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentStep: 3,
        walletAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        verified: true,
        invoiceAmount: "100.00",
        invoiceRecipient: "test@example.com",
        invoiceCreated: true,
      }),
    );

    renderWizard();
    expect(within(wizardBody()).getByText(/you're all set/i)).toBeInTheDocument();

    const allButtons = screen.queryAllByRole("button");
    const backBtn = allButtons.find((b) => b.textContent?.trim() === "Back");
    expect(backBtn).toBeDefined();
  });

  it("does not auto-advance when the user is on a previously-completed step", () => {
    // User navigated back to verify (step 1); verified is already true.
    // Clicking Next should move to step 3 (invoice) without losing invoice data.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentStep: 1,
        walletAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        verified: true,
        invoiceAmount: "100",
        invoiceRecipient: "buyer@example.com",
        invoiceCreated: false,
      }),
    );

    renderWizard();

    // Step 2 shows "Address verified" badge — no re-verify button
    expect(within(wizardBody()).getByText(/address verified/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /verify address/i }),
    ).not.toBeInTheDocument();

    // The user can proceed via Next without losing invoice form data
    clickNext();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Create Invoice");
    expect(screen.getByDisplayValue("buyer@example.com")).toBeInTheDocument();
  });
});

const ADDRESS = "G" + "A".repeat(55);
const COMPLETED_KEY = "comebackhere_onboarding_completed";

describe("OnboardingWizard — canonical wallet integration", () => {
  it("calls onConnectWallet from the wallet step", () => {
    const onConnectWallet = vi.fn();
    renderWizard(vi.fn(), { onConnectWallet });
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));
    expect(onConnectWallet).toHaveBeenCalledTimes(1);
  });

  it("advances to the verify step once useWallet reports an address", () => {
    const { rerender } = renderWizard();
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Connect Wallet");

    rerender(
      <OnboardingWizard onComplete={vi.fn()} onConnectWallet={vi.fn()} walletAddress={ADDRESS} />,
    );
    expect(within(wizardBody()).getByRole("heading", { level: 3 })).toHaveTextContent("Verify Address");
    expect(screen.getByDisplayValue(ADDRESS)).toBeInTheDocument();
  });

  it("shows the wallet error from useWallet on the wallet step", () => {
    renderWizard(vi.fn(), { walletError: "Freighter wallet not detected" });
    expect(screen.getByText("Freighter wallet not detected")).toBeInTheDocument();
  });

  it("walks through every step and clears saved progress on completion", () => {
    const onComplete = vi.fn();
    renderWizard(onComplete, { walletAddress: ADDRESS });

    fireEvent.click(screen.getByRole("button", { name: /verify address/i }));
    fireEvent.change(screen.getByPlaceholderText("100.00"), { target: { value: "25" } });
    fireEvent.change(screen.getByPlaceholderText(/customer@example.com/i), {
      target: { value: "buyer@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create invoice/i }));
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("closes via the close button and Escape when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    renderWizard(vi.fn(), { onDismiss });
    fireEvent.click(screen.getByRole("button", { name: /close setup guide/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("renders as a labelled modal dialog", () => {
    renderWizard();
    expect(screen.getByRole("dialog", { name: /welcome to comebackhere/i })).toBeInTheDocument();
  });
});

describe("useOnboarding — first visit only", () => {
  it("shows the wizard on the first visit", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.showWizard).toBe(true);
  });

  it("remembers completion and hides the wizard on later visits", () => {
    const first = renderHook(() => useOnboarding());
    act(() => first.result.current.closeWizard());
    expect(first.result.current.showWizard).toBe(false);
    expect(localStorage.getItem(COMPLETED_KEY)).toBe("true");

    const second = renderHook(() => useOnboarding());
    expect(second.result.current.showWizard).toBe(false);
  });

  it("can be reopened from the UI after completion", () => {
    localStorage.setItem(COMPLETED_KEY, "true");
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.showWizard).toBe(false);
    act(() => result.current.openWizard());
    expect(result.current.showWizard).toBe(true);
  });

  it("shows the wizard again instead of crashing when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const { result } = renderHook(() => useOnboarding());
    expect(result.current.showWizard).toBe(true);
    expect(() => act(() => result.current.closeWizard())).not.toThrow();
    expect(result.current.showWizard).toBe(false);

    // The wizard itself also renders and saves progress without throwing.
    expect(() => renderWizard()).not.toThrow();
  });
});
