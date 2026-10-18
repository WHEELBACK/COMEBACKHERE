export type Network = 'testnet' | 'mainnet' | 'unknown';

export function getNetwork(): Network {
  const env = import.meta.env.VITE_STELLAR_NETWORK as string | undefined;
  if (env === 'testnet') return 'testnet';
  if (env === 'mainnet') return 'mainnet';
  return 'unknown';
}

export function getExplorerBase(network: Network): string {
  const domain = network === 'mainnet' ? 'stellar.expert' : 'stellar.expert/testnet';
  return `https://${domain}`;
}

export function getTransactionUrl(txHash: string, network?: Network): string | null {
  const net = network || getNetwork();
  if (net === 'unknown') return null;
  return `${getExplorerBase(net)}/tx/${txHash}`;
}

export function getAccountUrl(accountId: string, network?: Network): string | null {
  const net = network || getNetwork();
  if (net === 'unknown') return null;
  return `${getExplorerBase(net)}/account/${accountId}`;
}

export function getContractUrl(contractId: string, network?: Network): string | null {
  const net = network || getNetwork();
  if (net === 'unknown') return null;
  return `${getExplorerBase(net)}/contract/${contractId}`;
}
