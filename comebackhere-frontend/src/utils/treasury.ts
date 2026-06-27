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

function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE || Networks.STANDALONE
}

function getServer() {
  const { SorobanRpc } = window as any
  return new SorobanRpc.Server(SOROBAN_RPC)
}

async function getPublicKey(): Promise<string> {
  const { address } = await (window as any).freighterApi.getAddress()
  return address
}

/**
 * Returns the list of currently allowlisted token contract addresses.
 */
export async function getAllowedTokens(): Promise<string[]> {
  const server = getServer()
  const contract = new Contract(TREASURY_CONTRACT_ID)

  const result = await server.simulateTransaction(
    new TransactionBuilder(await server.getAccount(TREASURY_CONTRACT_ID), {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call("get_allowed_tokens"))
      .setTimeout(30)
      .build()
  )

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
    const args = [nativeToScVal(tokenAddress, { type: "address" })]

    const tx = new TransactionBuilder(await server.getAccount(publicKey), {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call(operation, ...args))
      .setTimeout(30)
      .build()

    const simulated = await server.simulateTransaction(tx)
    const { SorobanRpc } = window as any
    const prepare = SorobanRpc.assembleTransaction(tx, simulated)
    const signed = await (window as any).freighterApi.signTransaction(
      prepare.toXDR(),
      { networkPassphrase: getNetworkPassphrase() }
    )

    const txHash = await server.sendTransaction(signed)
    return { success: true, hash: txHash.hash }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Transaction failed" }
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
