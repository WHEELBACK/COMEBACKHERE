/**
 * Block-explorer URL helpers. The explorer network segment is derived from the
 * configured network passphrase so links never point at the wrong network.
 */

const EXPLORER_NETWORK_SEGMENTS: Record<string, string> = {
  "Public Global Stellar Network ; September 2015": "public",
  "Test SDF Network ; September 2015": "testnet",
}

/** Stellar Expert base URL for transactions on the given network passphrase. */
export function getExplorerTxBaseUrl(passphrase?: string): string {
  const value = passphrase ?? import.meta.env.VITE_NETWORK_PASSPHRASE ?? ""
  const segment = EXPLORER_NETWORK_SEGMENTS[value] ?? "testnet"
  return `https://stellar.expert/explorer/${segment}/tx`
}
