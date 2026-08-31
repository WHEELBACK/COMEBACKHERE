/**
 * Tests for OnboardingWizard back navigation without data loss (Issue #2).
 *
 * Verifies that:
 *  - a Back button is present on every step after the first.
 *  - navigating back and then forward again preserves data entered on later steps.
 *  - localStorage state is preserved across back/forward navigation.
 *  - completed-step badges remain visible when the user returns to a step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, within } from "@testing-library/react";
import OnboardingWizard from "./OnboardingWizard";

const STORAGE_KEY = "comebackhere_onboarding_state";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard(onComplete = vi.fn()) {
  return render(<OnboardingWizard onComplete={onComplete} />);
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
