import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  nativeToScVal,
} from "soroban-client"

const TREASURY_CONTRACT_ID =
  import.meta.env.VITE_TREASURY_CONTRACT_ID as string
const SOROBAN_RPC = import.meta.env.VITE_SOROBAN_RPC as string
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string

interface FreighterApi {
  getAddress: () => Promise<{ address: string }>
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
}

interface SorobanRpcApi {
  Server: new (url: string) => {
    getAccount: (address: string) => Promise<unknown>
    simulateTransaction: (tx: unknown) => Promise<unknown>
    sendTransaction: (tx: unknown) => Promise<{ hash: string }>
  }
  assembleTransaction: (tx: unknown, sim: unknown) => { toXDR: () => string }
}

interface WindowWithWallet extends Window {
  freighterApi?: FreighterApi
  SorobanRpc?: SorobanRpcApi
}

function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE || Networks.STANDALONE
}

function getServer() {
  const sorobanRpc = (window as WindowWithWallet).SorobanRpc
  if (!sorobanRpc) throw new Error("SorobanRpc not available on window")
  return new sorobanRpc.Server(SOROBAN_RPC)
}

async function getPublicKey(): Promise<string> {
  const freighter = (window as WindowWithWallet).freighterApi
  if (!freighter) throw new Error("Freighter wallet not detected")
  const { address } = await freighter.getAddress()
  return address
}

/**
 * Returns the list of currently allowlisted token contract addresses.
 */
export async function getAllowedTokens(): Promise<string[]> {
  const server = getServer()
  const contract = new Contract(TREASURY_CONTRACT_ID)

  const result = await server.simulateTransaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new TransactionBuilder(await server.getAccount(TREASURY_CONTRACT_ID) as any, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call("get_allowed_tokens"))
      .setTimeout(30)
      .build()
  ) as { result?: { retval?: xdr.ScVal } }

  if (!result.result?.retval) return []

  const vec: xdr.ScVal[] = result.result.retval.vec() ?? []
  return vec.map((v) => {
    try {
      return v.address().toString()
    } catch {
      return v.toString()
    }
  })
}

async function submitTokenOp(
  operation: "add_allowed_token" | "remove_allowed_token",
  tokenAddress: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  try {
    const server = getServer()
    const contract = new Contract(TREASURY_CONTRACT_ID)
    const publicKey = await getPublicKey()
    const freighter = (window as WindowWithWallet).freighterApi
    if (!freighter) throw new Error("Freighter wallet not detected")
    const sorobanRpc = (window as WindowWithWallet).SorobanRpc
    if (!sorobanRpc) throw new Error("SorobanRpc not available on window")

    const args = [nativeToScVal(tokenAddress, { type: "address" })]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = new TransactionBuilder(await server.getAccount(publicKey) as any, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call(operation, ...args))
      .setTimeout(30)
      .build()

    const simulated = await server.simulateTransaction(tx)
    const prepare = sorobanRpc.assembleTransaction(tx, simulated)
    const signed = await freighter.signTransaction(
      prepare.toXDR(),
      { networkPassphrase: getNetworkPassphrase() }
    )

    const txHash = await server.sendTransaction(signed)
    return { success: true, hash: txHash.hash }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : "Transaction failed" }
  }
}

export function addAllowedToken(
  tokenAddress: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTokenOp("add_allowed_token", tokenAddress)
}

export function removeAllowedToken(
  tokenAddress: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTokenOp("remove_allowed_token", tokenAddress)
}

export interface TreasuryBalance {
  token: string
  balance: string
}

export interface PendingSettlement {
  id: string
  amount: string
  approvals: string[]
  approval_weight: number
  threshold: number
  status: 'Pending' | 'ReadyToExecute' | 'Executed'
}

/**
 * Fetches current treasury balances for a given wallet address from the
 * backend balances endpoint.
 */
export async function fetchBalances(walletAddress: string): Promise<TreasuryBalance[]> {
  const apiBase = (import.meta.env.VITE_API_BASE as string) ?? "/api"
  const res = await fetch(`${apiBase}/treasury/balances?address=${encodeURIComponent(walletAddress)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<TreasuryBalance[]>
}

/**
 * Fetches pending settlements awaiting multisig approval.
 */
export async function fetchPendingSettlements(): Promise<PendingSettlement[]> {
  const apiBase = (import.meta.env.VITE_API_BASE as string) ?? "/api"
  const res = await fetch(`${apiBase}/treasury/settlements?status=Pending`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<PendingSettlement[]>
}

/**
 * Approves a pending settlement on behalf of a signer.
 */
export async function approveSettlement(
  settlementId: string,
  walletAddress: string,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const apiBase = (import.meta.env.VITE_API_BASE as string) ?? "/api"
  try {
    const res = await fetch(`${apiBase}/treasury/settlements/${settlementId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: walletAddress }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    const data = await res.json() as { hash?: string }
    return { success: true, hash: data.hash }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : "Approve failed" }
  }
}

/**
 * Executes a settlement that has reached the approval threshold.
 */
export async function executeSettlement(
  settlementId: string,
  walletAddress: string,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const apiBase = (import.meta.env.VITE_API_BASE as string) ?? "/api"
  try {
    const res = await fetch(`${apiBase}/treasury/settlements/${settlementId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: walletAddress }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    const data = await res.json() as { hash?: string }
    return { success: true, hash: data.hash }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : "Execute failed" }
  }
}

/**
 * Fetches the current multisig approval threshold from the backend.
 */
export async function fetchThreshold(): Promise<number> {
  const apiBase = (import.meta.env.VITE_API_BASE as string) ?? "/api"
  const res = await fetch(`${apiBase}/treasury/threshold`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { threshold: number }
  return data.threshold
}
