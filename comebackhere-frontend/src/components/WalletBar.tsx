import type { FC, ReactNode } from "react"
import type { WalletState } from "../hooks/useWallet"

interface WalletBarProps {
  wallet: WalletState
  onConnect: () => void
  onRetry?: () => void
  onDisconnect?: () => void
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Human-readable name for a network passphrase, e.g. "Test SDF Network". */
function networkName(passphrase: string): string {
  return passphrase.split(";")[0].trim() || passphrase
}

export const WalletBar: FC<WalletBarProps> = ({ wallet, onConnect, onRetry, onDisconnect }) => {
  const retry = onRetry ?? onConnect

  const disconnectButton = onDisconnect && (
    <button
      className="btn btn--secondary btn--sm"
      onClick={onDisconnect}
      data-testid="disconnect-wallet-btn"
      aria-label="Disconnect wallet"
    >
      Disconnect
    </button>
  )

  let content: ReactNode
  switch (wallet.status) {
    case "not-installed":
      content = (
        <div className="wallet-error wallet-error--not-installed" role="alert">
          <span className="wallet-error__icon" aria-hidden="true">⚠️</span>
          <span className="wallet-error__message">Freighter wallet not detected</span>
          <a
            href="https://www.freighter.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--small btn--text"
          >
            Install Extension
          </a>
        </div>
      )
      break

    case "disconnected":
      content = wallet.error ? (
        <div className="wallet-error wallet-error--generic" role="alert">
          <span className="wallet-error__icon" aria-hidden="true">❌</span>
          <span className="wallet-error__message">{wallet.error}</span>
          <button className="btn btn--small btn--text" onClick={retry} data-testid="retry-connect-btn">
            Try Again
          </button>
        </div>
      ) : (
        <button className="btn btn--primary btn--sm" onClick={onConnect} data-testid="connect-wallet-btn">
          Connect Wallet
        </button>
      )
      break

    case "connecting":
      content = (
        <div className="wallet-status wallet-status--connecting" role="status" aria-live="polite">
          <span className="wallet-spinner" aria-hidden="true" />
          <span>Connecting… approve the request in Freighter</span>
          <button className="btn btn--primary btn--sm" disabled data-testid="connect-wallet-btn">
            Connecting...
          </button>
        </div>
      )
      break

    case "rejected":
      content =
        wallet.reason === "locked" ? (
          <div className="wallet-error wallet-error--locked" role="alert">
            <span className="wallet-error__icon" aria-hidden="true">🔒</span>
            <span className="wallet-error__message">Wallet is locked</span>
            <button className="btn btn--small btn--text" onClick={retry} data-testid="unlock-wallet-btn">
              Unlock & Retry
            </button>
          </div>
        ) : (
          <div className="wallet-error wallet-error--rejected" role="alert">
            <span className="wallet-error__icon" aria-hidden="true">🚫</span>
            <span className="wallet-error__message">Connection request rejected</span>
            <button className="btn btn--small btn--text" onClick={retry} data-testid="retry-connect-btn">
              Try Again
            </button>
          </div>
        )
      break

    case "connected":
      content = (
        <div className="wallet-status wallet-status--connected">
          <span className="wallet-dot" aria-hidden="true" />
          <span
            className="wallet-address"
            data-testid="wallet-address"
            aria-label={`Wallet connected: ${wallet.address}`}
            title={wallet.address}
          >
            {shortAddress(wallet.address)}
          </span>
          {disconnectButton}
        </div>
      )
      break

    case "wrong-network":
      content = (
        <div className="wallet-status wallet-status--wrong-network">
          <span className="network-warning" role="alert" data-testid="network-warning">
            <span aria-hidden="true">⚠️ </span>
            Wrong network ({networkName(wallet.network)}). Switch Freighter to {networkName(wallet.expectedNetwork)}
            <span className="sr-only"> ({wallet.expectedNetwork})</span>
          </span>
          <span className="wallet-address" data-testid="wallet-address" title={wallet.address}>
            {shortAddress(wallet.address)}
          </span>
          {disconnectButton}
        </div>
      )
      break

    default: {
      const unreachable: never = wallet
      content = unreachable
    }
  }

  return (
    <div className={`wallet-bar wallet-bar--${wallet.status}`} data-wallet-status={wallet.status}>
      {/* Keyed so each state change remounts and plays the enter transition */}
      <div key={wallet.status} className="wallet-bar__state">
        {content}
      </div>
    </div>
  )
}
