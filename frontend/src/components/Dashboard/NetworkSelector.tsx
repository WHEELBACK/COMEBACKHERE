import { useState, useCallback } from "react";
import { useNetwork } from "../../hooks/useNetwork";
import "./NetworkSelector.css";

/**
 * Context key used by any form in the dashboard to register itself as "dirty".
 * Forms call `window.__networkSelectorDirtyForms.add(key)` on change and
 * `window.__networkSelectorDirtyForms.delete(key)` on submit/reset.
 *
 * NetworkSelector reads this set before switching networks so it can prompt
 * the user when unsaved state would be lost.
 */
declare global {
  interface Window {
    __networkSelectorDirtyForms?: Set<string>;
  }
}

/** Returns true when at least one form has registered unsaved state. */
function hasDirtyForms(): boolean {
  return (window.__networkSelectorDirtyForms?.size ?? 0) > 0;
}

export default function NetworkSelector() {
  const { network, setNetwork, isMainnet } = useNetwork();
  const [pendingNetwork, setPendingNetwork] = useState<
    "testnet" | "mainnet" | null
  >(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as "testnet" | "mainnet";
      if (next === network) return;

      if (hasDirtyForms()) {
        // Park the requested switch and ask for confirmation.
        setPendingNetwork(next);
      } else {
        setNetwork(next);
      }
    },
    [network, setNetwork],
  );

  const confirmSwitch = useCallback(() => {
    if (pendingNetwork) {
      setNetwork(pendingNetwork);
    }
    setPendingNetwork(null);
  }, [pendingNetwork, setNetwork]);

  const cancelSwitch = useCallback(() => {
    setPendingNetwork(null);
  }, []);

  return (
    <div className="network-selector">
      <select
        className="network-selector__select"
        value={network}
        onChange={handleChange}
        aria-label="Select network"
      >
        <option value="testnet">Testnet</option>
        <option value="mainnet">Mainnet</option>
      </select>

      {isMainnet && (
        <div className="network-selector__warning" role="alert">
          ⚠️ You are connected to <strong>Mainnet</strong>. Transactions are
          irreversible and use real funds.
        </div>
      )}

      {pendingNetwork !== null && (
        <div
          className="network-selector__confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ns-confirm-title"
          aria-describedby="ns-confirm-desc"
        >
          <div className="network-selector__confirm-dialog">
            <h3 id="ns-confirm-title" className="network-selector__confirm-title">
              Unsaved changes
            </h3>
            <p id="ns-confirm-desc" className="network-selector__confirm-body">
              You have unsaved form data. Switching to{" "}
              <strong>{pendingNetwork}</strong> will discard those changes. Do
              you want to continue?
            </p>
            <div className="network-selector__confirm-actions">
              <button
                type="button"
                className="network-selector__btn network-selector__btn--danger"
                onClick={confirmSwitch}
                data-testid="ns-confirm-switch"
              >
                Switch network
              </button>
              <button
                type="button"
                className="network-selector__btn network-selector__btn--secondary"
                onClick={cancelSwitch}
                data-testid="ns-cancel-switch"
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
