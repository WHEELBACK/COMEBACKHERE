/**
 * Network awareness for the canonical frontend.
 *
 * The app's expected network comes from `VITE_NETWORK_PASSPHRASE` (the same
 * value the Soroban helpers sign with), never a hard-coded string. The
 * wallet's network is the passphrase reported by Freighter via `useWallet`.
 */

const KNOWN_NETWORKS: Record<string, string> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "standalone",
}

/** The passphrase the app is configured for, from the frontend env. */
export function getExpectedNetworkPassphrase(): string {
  return import.meta.env.VITE_NETWORK_PASSPHRASE ?? ""
}

/** Human-friendly name for a passphrase ("testnet", "mainnet", …). */
export function networkName(passphrase: string | null): string | null {
  if (!passphrase) return null
  return KNOWN_NETWORKS[passphrase] ?? passphrase
}

interface UseNetworkOptions {
  /** Passphrase reported by the wallet (`useWallet().network`). */
  walletPassphrase: string | null
  connected: boolean
  connecting?: boolean
}

export interface NetworkState {
  /** Display name of the network the app expects. */
  network: string
  /** Display name of the wallet's network, or null when unknown. */
  walletNetwork: string | null
  hasNetworkMismatch: boolean
  isCheckingWallet: boolean
}

export function useNetwork({
  walletPassphrase,
  connected,
  connecting = false,
}: UseNetworkOptions): NetworkState {
  const expected = getExpectedNetworkPassphrase()
  const hasNetworkMismatch =
    connected && !!expected && walletPassphrase !== null && walletPassphrase !== expected

  return {
    network: networkName(expected) ?? "unknown",
    walletNetwork: networkName(walletPassphrase),
    hasNetworkMismatch,
    isCheckingWallet: connecting,
  }
}
