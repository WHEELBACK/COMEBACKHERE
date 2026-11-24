/**
 * Persistence for the onboarding wizard.
 *
 * Every localStorage access is wrapped in try/catch: in private browsing or
 * with storage blocked, reads fall back to "not completed" (so the wizard
 * simply shows again) and writes are dropped instead of crashing the app.
 */

export const ONBOARDING_STATE_KEY = "comebackhere_onboarding_state"
export const ONBOARDING_COMPLETED_KEY = "comebackhere_onboarding_completed"

export interface WizardState {
  currentStep: number
  walletAddress: string
  verified: boolean
  invoiceAmount: string
  invoiceRecipient: string
  invoiceCreated: boolean
}

export const INITIAL_WIZARD_STATE: WizardState = {
  currentStep: 0,
  walletAddress: "",
  verified: false,
  invoiceAmount: "",
  invoiceRecipient: "",
  invoiceCreated: false,
}

export function loadWizardState(): WizardState {
  try {
    const stored = window.localStorage.getItem(ONBOARDING_STATE_KEY)
    if (stored) {
      return { ...INITIAL_WIZARD_STATE, ...(JSON.parse(stored) as Partial<WizardState>) }
    }
  } catch {
    // unreadable or corrupt state: start from the first step
  }
  return INITIAL_WIZARD_STATE
}

export function saveWizardState(state: WizardState): void {
  try {
    window.localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(state))
  } catch {
    // storage unavailable: progress lives only in memory
  }
}

export function clearWizardState(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_STATE_KEY)
  } catch {
    // ignore storage errors
  }
}

export function isOnboardingComplete(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "true"
  } catch {
    return false
  }
}

export function markOnboardingComplete(): void {
  try {
    window.localStorage.setItem(ONBOARDING_COMPLETED_KEY, "true")
  } catch {
    // ignore storage errors: the wizard will show again next visit
  }
}
