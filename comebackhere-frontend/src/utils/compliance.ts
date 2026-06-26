import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  nativeToScVal,
} from "soroban-client"

export type ComplianceStatus = "Allowed" | "AllowedUntil" | "Blocked" | "Cleared"

export interface ComplianceStatusResult {
  status: ComplianceStatus
  expiresAt?: number | null
}

const COMPLIANCE_CONTRACT_ID =
  import.meta.env.VITE_COMPLIANCE_CONTRACT_ID as string
const SOROBAN_RPC = import.meta.env.VITE_SOROBAN_RPC as string
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string

function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE || Networks.STANDALONE
}

function getServer() {
  const { SorobanRpc } = window as any
  return new SorobanRpc.Server(SOROBAN_RPC)
}

function u64ToNumber(value: xdr.Uint64 | undefined): number {
  return Number(value?.toString() ?? 0)
}

function parseAddressStatus(scVal: xdr.ScVal): ComplianceStatusResult {
  const vec = scVal.vec()
  const variant = vec?.[0]?.sym()?.toString() ?? "Cleared"
  if (variant === "AllowedUntil") {
    const until = u64ToNumber(vec?.[1]?.u64())
    return { status: variant as ComplianceStatus, expiresAt: until }
  }
  return { status: variant as ComplianceStatus, expiresAt: null }
}

export async function getAddressStatus(
  address: string
): Promise<ComplianceStatusResult> {
  const server = getServer()
  const contract = new Contract(COMPLIANCE_CONTRACT_ID)
  const args = [nativeToScVal(address, { type: "address" })]

  const result = await server.simulateTransaction(
    new TransactionBuilder(await server.getAccount(COMPLIANCE_CONTRACT_ID), {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call("get_address_status", ...args))
      .setTimeout(30)
      .build()
  )

  if (!result.result || !result.result.retval) {
    throw new Error("Unable to fetch address status")
  }

  return parseAddressStatus(result.result.retval)
}

async function submitTransaction(
  publicKey: string,
  operation: string,
  args: xdr.ScVal[]
): Promise<{ success: boolean; error?: string; hash?: string }> {
  try {
    const server = getServer()
    const contract = new Contract(COMPLIANCE_CONTRACT_ID)
    const account = await server.getAccount(publicKey)
    const tx = new TransactionBuilder(account, {
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
    return {
      success: false,
      error: err?.message ?? err?.toString() ?? "Contract transaction failed",
    }
  }
}

export async function allowAddress(
  address: string,
  publicKey: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTransaction(publicKey, "allow_address", [
    nativeToScVal(address, { type: "address" }),
  ])
}

export async function blockAddress(
  address: string,
  publicKey: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTransaction(publicKey, "block_address", [
    nativeToScVal(address, { type: "address" }),
  ])
}

export async function clearAddress(
  address: string,
  publicKey: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTransaction(publicKey, "clear_address", [
    nativeToScVal(address, { type: "address" }),
  ])
}

export async function allowAddressUntil(
  address: string,
  untilTimestamp: number,
  publicKey: string
): Promise<{ success: boolean; error?: string; hash?: string }> {
  return submitTransaction(publicKey, "allow_address_until", [
    nativeToScVal(address, { type: "address" }),
    nativeToScVal(untilTimestamp, { type: "u64" }),
  ])
}
