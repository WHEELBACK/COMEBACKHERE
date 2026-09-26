import { useState, useEffect } from "react"
import { useNetwork } from "../hooks/useNetwork"
import "./NetworkMismatchBanner.css"

const DISMISS_STORAGE_KEY = "comebackhere-network-mismatch-dismissed"

function getDismissedState(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

interface NetworkMismatchBannerProps {
  /** Passphrase reported by Freighter (`useWallet().network`). */
  walletPassphrase: string | null
  connected: boolean
  connecting?: boolean
}

export default function NetworkMismatchBanner({
  walletPassphrase,
  connected,
  connecting = false,
}: NetworkMismatchBannerProps) {
  const { hasNetworkMismatch, network, walletNetwork, isCheckingWallet } = useNetwork({
    walletPassphrase,
    connected,
    connecting,
  })
  const [dismissed, setDismissed] = useState<boolean>(getDismissedState)

  // Reset the dismissed flag once the mismatch resolves so the banner shows
  // again if the wallet later drifts onto the wrong network.
  useEffect(() => {
    if (!hasNetworkMismatch) {
      try {
        window.localStorage.removeItem(DISMISS_STORAGE_KEY)
      } catch {
        // ignore storage errors
      }
      setDismissed(false)
    }
  }, [hasNetworkMismatch])

  if (isCheckingWallet || !hasNetworkMismatch || dismissed) {
    return null
  }

  function handleDismiss() {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, "true")
    } catch {
      // ignore storage errors
    }
    setDismissed(true)
  }

  return (
    <div className="network-mismatch-banner" role="alert">
      <div className="network-mismatch-banner__header">
        <h3 className="network-mismatch-banner__title">Network Mismatch</h3>
        <button
          className="network-mismatch-banner__dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss network mismatch banner"
          type="button"
        >
          ✕
        </button>
      </div>
      <p className="network-mismatch-banner__message">
        Your wallet is connected to <strong>{walletNetwork}</strong>, but ComebackHere is
        configured for <strong>{network}</strong>. Switch networks in Freighter before signing
        any transaction.
      </p>
      <div className="network-mismatch-banner__details">
        <div>
          <span className="network-mismatch-banner__label">App Network</span>
          <span className="network-mismatch-banner__value">{network}</span>
        </div>
        <div>
          <span className="network-mismatch-banner__label">Wallet Network</span>
          <span className="network-mismatch-banner__value">{walletNetwork || "Unknown"}</span>
        </div>
      </div>
      <p className="network-mismatch-banner__action">
        Transactions will fail until networks match.
      </p>
    </div>
  )
}
