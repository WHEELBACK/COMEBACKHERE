import { useState, useEffect } from "react"
import {
  loadWizardState,
  saveWizardState,
  clearWizardState,
  type WizardState,
} from "./onboardingStorage"
import "./OnboardingWizard.css"

type Step = "wallet" | "verify" | "invoice" | "done"

const STEPS: { key: Step; title: string; description: string }[] = [
  {
    key: "wallet",
    title: "Connect Wallet",
    description: "Link your Stellar wallet to start accepting payments.",
  },
  {
    key: "verify",
    title: "Verify Address",
    description: "Confirm your Stellar address to enable payouts.",
  },
  {
    key: "invoice",
    title: "Create Invoice",
    description: "Set up your first invoice and share it with a customer.",
  },
  {
    key: "done",
    title: "All Set",
    description: "Your merchant account is ready.",
  },
]

interface OnboardingWizardProps {
  /** Called when the merchant finishes the last step. */
  onComplete: () => void
  /** Called when the merchant closes the wizard early. */
  onDismiss?: () => void
  /** Connected address from useWallet, if any. */
  walletAddress?: string | null
  /** Wallet error from useWallet, shown on the wallet step. */
  walletError?: string | null
  /** useWallet().connect */
  onConnectWallet: () => Promise<void> | void
}

export default function OnboardingWizard({
  onComplete,
  onDismiss,
  walletAddress: connectedAddress = null,
  walletError = null,
  onConnectWallet,
}: OnboardingWizardProps) {
  const [initialState] = useState(loadWizardState)
  const [currentStep, setCurrentStep] = useState(initialState.currentStep)
  const [walletAddress, setWalletAddress] = useState(initialState.walletAddress)
  const [verified, setVerified] = useState(initialState.verified)
  const [invoiceAmount, setInvoiceAmount] = useState(initialState.invoiceAmount)
  const [invoiceRecipient, setInvoiceRecipient] = useState(initialState.invoiceRecipient)
  const [invoiceCreated, setInvoiceCreated] = useState(initialState.invoiceCreated)
  const [error, setError] = useState<string | null>(null)

  // Persist progress so a reload resumes where the merchant left off.
  useEffect(() => {
    const state: WizardState = {
      currentStep,
      walletAddress,
      verified,
      invoiceAmount,
      invoiceRecipient,
      invoiceCreated,
    }
    saveWizardState(state)
  }, [currentStep, walletAddress, verified, invoiceAmount, invoiceRecipient, invoiceCreated])

  // Pick up the address once useWallet connects. Only advance from the wallet
  // step itself so navigating back to re-inspect it never jumps forward.
  useEffect(() => {
    if (!connectedAddress) return
    setWalletAddress(connectedAddress)
    setCurrentStep((step) => (step === 0 ? 1 : step))
  }, [connectedAddress])

  useEffect(() => {
    if (!onDismiss) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onDismiss])

  const step = STEPS[currentStep] ?? STEPS[0]

  function canProceedToNext(): boolean {
    switch (currentStep) {
      case 0:
        return walletAddress.length > 0
      case 1:
        return verified
      case 2:
        return invoiceCreated
      default:
        return true
    }
  }

  async function handleConnectWallet() {
    setError(null)
    try {
      await onConnectWallet()
    } catch {
      setError("Failed to connect wallet. Is Freighter installed and unlocked?")
    }
  }

  function handleVerifyAddress() {
    setError(null)
    if (!walletAddress) {
      setError("No wallet connected. Go back and connect your wallet first.")
      return
    }
    if (!walletAddress.startsWith("G") || walletAddress.length !== 56) {
      setError("Invalid Stellar address format.")
      return
    }
    setVerified(true)
    if (currentStep === 1) {
      setCurrentStep(2)
    }
  }

  function handleCreateInvoice() {
    setError(null)
    const amount = parseFloat(invoiceAmount)
    if (!amount || amount <= 0) {
      setError("Enter a valid invoice amount greater than zero.")
      return
    }
    if (!invoiceRecipient.trim()) {
      setError("Enter a recipient email or wallet address.")
      return
    }
    setInvoiceCreated(true)
    if (currentStep === 2) {
      setCurrentStep(3)
    }
  }

  function handleNext() {
    if (!canProceedToNext()) {
      const messages = [
        "Please connect your wallet to proceed.",
        "Please verify your address to proceed.",
        "Please create an invoice to proceed.",
      ]
      setError(messages[currentStep] ?? null)
      return
    }
    setError(null)
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((prev) => prev + 1)
    } else {
      handleFinish()
    }
  }

  function handleFinish() {
    clearWizardState()
    onComplete()
  }

  /**
   * Go to the previous step. Data entered on later steps stays in state and
   * localStorage; it is only cleared when the whole flow completes.
   */
  function handleBack() {
    setError(null)
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1)
    }
  }

  function renderStepContent() {
    switch (step.key) {
      case "wallet":
        return (
          <div className="wizard-step-content">
            <p>{step.description}</p>
            {walletAddress ? (
              <div className="wizard-success-box">
                <span className="wizard-check" aria-hidden="true">&#10003;</span>
                <span className="wizard-address">{walletAddress}</span>
              </div>
            ) : (
              <>
                <button className="btn btn--primary" type="button" onClick={handleConnectWallet}>
                  Connect Freighter Wallet
                </button>
                {walletError && !error && (
                  <p className="message message--error wizard-message">{walletError}</p>
                )}
              </>
            )}
          </div>
        )
      case "verify":
        return (
          <div className="wizard-step-content">
            <p>{step.description}</p>
            <div className="wizard-field">
              <label className="wizard-label" htmlFor="wizard-wallet-address">
                Wallet Address
              </label>
              <input
                id="wizard-wallet-address"
                className="wizard-input"
                type="text"
                value={walletAddress}
                readOnly
              />
            </div>
            {verified ? (
              <div className="wizard-verified">
                <span className="wizard-check" aria-hidden="true">&#10003;</span> Address verified
              </div>
            ) : (
              <button className="btn btn--primary" type="button" onClick={handleVerifyAddress}>
                Verify Address
              </button>
            )}
          </div>
        )
      case "invoice":
        return (
          <div className="wizard-step-content">
            <p>{step.description}</p>
            <div className="wizard-field">
              <label className="wizard-label" htmlFor="wizard-invoice-amount">
                Amount (USDC)
              </label>
              <input
                id="wizard-invoice-amount"
                className="wizard-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="100.00"
                value={invoiceAmount}
                onChange={(e) => setInvoiceAmount(e.target.value)}
                disabled={invoiceCreated}
              />
            </div>
            <div className="wizard-field">
              <label className="wizard-label" htmlFor="wizard-invoice-recipient">
                Recipient
              </label>
              <input
                id="wizard-invoice-recipient"
                className="wizard-input"
                type="text"
                placeholder="customer@example.com or G..."
                value={invoiceRecipient}
                onChange={(e) => setInvoiceRecipient(e.target.value)}
                disabled={invoiceCreated}
              />
            </div>
            {invoiceCreated ? (
              <div className="wizard-verified">
                <span className="wizard-check" aria-hidden="true">&#10003;</span> Invoice created
              </div>
            ) : (
              <button className="btn btn--primary" type="button" onClick={handleCreateInvoice}>
                Create Invoice
              </button>
            )}
          </div>
        )
      case "done":
        return (
          <div className="wizard-step-content">
            <p>You&#39;re all set! Your merchant account is configured and your first invoice is ready.</p>
            <button className="btn btn--primary" type="button" onClick={handleFinish}>
              Get Started
            </button>
          </div>
        )
    }
  }

  return (
    <div className="modal-overlay wizard-overlay">
      <div
        className="modal wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <div className="wizard-header">
          <h2 className="wizard-title" id="wizard-title">Welcome to ComebackHere</h2>
          <p className="wizard-subtitle">Complete these steps to start accepting payments</p>
          {onDismiss && (
            <button
              type="button"
              className="wizard-close"
              onClick={onDismiss}
              aria-label="Close setup guide"
            >
              ✕
            </button>
          )}
        </div>

        <ol className="wizard-progress">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={`wizard-progress-step${i === currentStep ? " wizard-progress-step--active" : ""}${i < currentStep ? " wizard-progress-step--done" : ""}`}
              aria-current={i === currentStep ? "step" : undefined}
            >
              <span className="wizard-progress-circle">{i < currentStep ? "✓" : i + 1}</span>
              <span className="wizard-progress-label">{s.title}</span>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          <h3 className="wizard-step-title">{step.title}</h3>
          {renderStepContent()}
          {error && (
            <p className="message message--error wizard-message" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="wizard-footer">
          {currentStep > 0 && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleBack}
              aria-label={`Go back to step ${currentStep} of ${STEPS.length}`}
            >
              Back
            </button>
          )}
          {currentStep < STEPS.length - 1 && (
            <button
              type="button"
              className="btn btn--primary wizard-next"
              onClick={handleNext}
              disabled={!canProceedToNext()}
              aria-label={`Proceed to step ${currentStep + 2} of ${STEPS.length}`}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
