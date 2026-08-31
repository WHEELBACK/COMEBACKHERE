import { useState, useEffect } from "react";
import { useNetwork } from "../hooks/useNetwork";
import "./NetworkMismatchBanner.css";

const DISMISS_STORAGE_KEY = "comebackhere-network-mismatch-dismissed";

function getDismissedState(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function NetworkMismatchBanner() {
  const { hasNetworkMismatch, network, walletNetwork, isCheckingWallet } = useNetwork();
  const [dismissed, setDismissed] = useState<boolean>(getDismissedState);

  // Clear the dismissed flag whenever the mismatch condition changes (e.g. the
  // user switches wallet network and then mismatches again on a new combo).
  useEffect(() => {
    if (!hasNetworkMismatch) {
      // Mismatch is resolved – reset so the banner shows again if it returns.
      try {
        window.localStorage.removeItem(DISMISS_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      setDismissed(false);
    }
  }, [hasNetworkMismatch]);

  if (isCheckingWallet || !hasNetworkMismatch || dismissed) {
    return null;
  }

  function handleDismiss() {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, "true");
    } catch {
      // ignore storage errors
    }
    setDismissed(true);
  }

  return (
    <div className="network-mismatch-banner" role="alert">
      <div className="network-mismatch-banner__content">
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
          Your wallet is connected to <strong>{walletNetwork}</strong>, but COMEBACKHERE is
          configured for <strong>{network}</strong>. Please switch your wallet network or change the
          app configuration to proceed with transactions.
        </p>
        <div className="network-mismatch-banner__details">
          <div>
            <span className="network-mismatch-banner__label">App Network:</span>
            <span className="network-mismatch-banner__value">{network}</span>
          </div>
          <div>
            <span className="network-mismatch-banner__label">Wallet Network:</span>
            <span className="network-mismatch-banner__value">{walletNetwork || "Unknown"}</span>
          </div>
        </div>
        <p className="network-mismatch-banner__action">
          ⚠️ Transactions will fail until networks match.
        </p>
      </div>
    </div>
  );
}
