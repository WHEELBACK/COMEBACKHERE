import { useState, useCallback } from "react"
import { isOnboardingComplete, markOnboardingComplete } from "./onboardingStorage"

/**
 * Shows the onboarding wizard on a merchant's first visit only. Finishing or
 * closing it is remembered; `openWizard` lets the merchant reopen it later.
 */
export function useOnboarding() {
  const [showWizard, setShowWizard] = useState(() => !isOnboardingComplete())

  const openWizard = useCallback(() => setShowWizard(true), [])

  const closeWizard = useCallback(() => {
    markOnboardingComplete()
    setShowWizard(false)
  }, [])

  return { showWizard, openWizard, closeWizard }
}
