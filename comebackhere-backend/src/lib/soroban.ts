import {
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Address,
  SorobanRpc,
  xdr,
} from "stellar-sdk"

export type SorobanClient = {
  getAccount: (publicKey: string) => Promise<ConstructorParameters<typeof TransactionBuilder>[0]>
  simulateTransaction: (
    tx: Parameters<SorobanRpc.Server["simulateTransaction"]>[0],
  ) => ReturnType<SorobanRpc.Server["simulateTransaction"]>
  sendTransaction: (
    tx: Parameters<SorobanRpc.Server["sendTransaction"]>[0],
  ) => ReturnType<SorobanRpc.Server["sendTransaction"]>
  getTransaction: (hash: string) => ReturnType<SorobanRpc.Server["getTransaction"]>
  getEvents: (
    params: Parameters<SorobanRpc.Server["getEvents"]>[0],
  ) => ReturnType<SorobanRpc.Server["getEvents"]>
  getLatestLedger: () => ReturnType<SorobanRpc.Server["getLatestLedger"]>
  getHealth?: () => ReturnType<SorobanRpc.Server["getHealth"]>
}

export function buildSorobanClient(rpcUrl: string): SorobanClient {
  const server = new SorobanRpc.Server(rpcUrl)
  return {
    getAccount: (pk) => server.getAccount(pk),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getTransaction: (hash) => server.getTransaction(hash),
    getEvents: (params) => server.getEvents(params),
    getLatestLedger: () => server.getLatestLedger(),
    getHealth: () => server.getHealth(),
  }
}

export function getNetworkPassphrase(): string {
  return process.env.NETWORK_PASSPHRASE ?? Networks.STANDALONE
}

export async function simulateContractRead(
  client: SorobanClient,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAccount: string,
  networkPassphrase: string,
): Promise<xdr.ScVal> {
  const contract = new Contract(contractId)
  const account = await client.getAccount(sourceAccount)
  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simulated = await client.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw Object.assign(
      new Error(`Soroban simulation failed: ${(simulated as { error?: string }).error}`),
      { status: 422 },
    )
  }

  const retval = (simulated as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval
  if (!retval) {
    throw Object.assign(new Error(`No return value from ${method}`), { status: 422 })
  }
  return retval
}

export async function getTokenBalance(
  client: SorobanClient,
  tokenContractId: string,
  holderAddress: string,
  sourceAccount: string,
  networkPassphrase: string,
): Promise<bigint> {
  const retval = await simulateContractRead(
    client,
    tokenContractId,
    "balance",
    [nativeToScVal(Address.fromString(holderAddress), { type: "address" })],
    sourceAccount,
    networkPassphrase,
  )
  const balance = retval.i128()
  if (!balance) {
    throw Object.assign(new Error("Invalid balance response from token contract"), { status: 422 })
  }
  return BigInt(balance.toString())
}

export interface OnChainSettlement {
  token: string
  amount: bigint
  merchant: string
  status: string
  approval_weight: bigint
}

function scValToSettlementStatus(scVal: xdr.ScVal): string {
  const variant = scVal.vec()?.[0]?.sym()?.toString() ?? "Pending"
  return variant
}

export async function getOnChainSettlement(
  client: SorobanClient,
  treasuryContractId: string,
  settlementId: bigint,
  sourceAccount: string,
  networkPassphrase: string,
): Promise<OnChainSettlement> {
  const retval = await simulateContractRead(
    client,
    treasuryContractId,
    "get_settlement",
    [nativeToScVal(settlementId, { type: "u64" })],
    sourceAccount,
    networkPassphrase,
  )

  const map = retval.map()
  if (!map) {
    throw Object.assign(new Error("Invalid settlement response"), { status: 422 })
  }

  const entries: Record<string, xdr.ScVal> = {}
  for (const entry of map) {
    const key = entry.key().sym().toString()
    entries[key] = entry.val()
  }

  return {
    token: entries.token?.address()?.toString() ?? "",
    amount: BigInt(entries.amount?.u64()?.toString() ?? "0"),
    merchant: entries.merchant?.address()?.toString() ?? "",
    status: scValToSettlementStatus(entries.status ?? xdr.ScVal.scvVoid()),
    approval_weight: BigInt(entries.approval_weight?.u64()?.toString() ?? "0"),
  }
}

export interface SettlementSimulation {
  settlementId: bigint
  status: string
  wouldSucceed: boolean
  approvalWeight: bigint
  threshold: bigint
  settlementAmount: bigint
  treasuryBalance: bigint
  projectedBalance: bigint
}

/**
 * Previews the outcome of `execute_settlement` for `settlementId` without submitting
 * or mutating any on-chain state, by simulating a call to the treasury contract's
 * read-only `simulate_settlement` function.
 */
export async function getSettlementSimulation(
  client: SorobanClient,
  treasuryContractId: string,
  settlementId: bigint,
  sourceAccount: string,
  networkPassphrase: string,
): Promise<SettlementSimulation> {
  const retval = await simulateContractRead(
    client,
    treasuryContractId,
    "simulate_settlement",
    [nativeToScVal(settlementId, { type: "u64" })],
    sourceAccount,
    networkPassphrase,
  )

  const map = retval.map()
  if (!map) {
    throw Object.assign(new Error("Invalid simulate_settlement response"), { status: 422 })
  }

  const entries: Record<string, xdr.ScVal> = {}
  for (const entry of map) {
    const key = entry.key().sym().toString()
    entries[key] = entry.val()
  }

  return {
    settlementId: BigInt(entries.settlement_id?.u64()?.toString() ?? "0"),
    status: scValToSettlementStatus(entries.status ?? xdr.ScVal.scvVoid()),
    wouldSucceed: entries.would_succeed?.b() ?? false,
    approvalWeight: BigInt(entries.approval_weight?.u64()?.toString() ?? "0"),
    threshold: BigInt(entries.threshold?.u64()?.toString() ?? "0"),
    settlementAmount: BigInt(entries.settlement_amount?.u64()?.toString() ?? "0"),
    treasuryBalance: BigInt(entries.treasury_balance?.i128()?.toString() ?? "0"),
    projectedBalance: BigInt(entries.projected_balance?.i128()?.toString() ?? "0"),
  }
}

export async function submitContractCall(
  client: SorobanClient,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  signerSecret: string,
  networkPassphrase: string,
): Promise<string> {
  const keypair = Keypair.fromSecret(signerSecret)
  const contract = new Contract(contractId)
  const account = await client.getAccount(keypair.publicKey())
  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simulated = await client.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw Object.assign(
      new Error(`Soroban simulation failed: ${(simulated as { error?: string }).error}`),
      { status: 422 },
    )
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simulated as any).build()
  prepared.sign(keypair)

  const sendResult = await client.sendTransaction(prepared)
  if (sendResult.status === "ERROR") {
    throw Object.assign(
      new Error(
        `Soroban submission failed: ${(sendResult as { errorResult?: { toXDR: (f: string) => string } }).errorResult?.toXDR("base64")}`,
      ),
      { status: 422 },
    )
  }

  const hash = sendResult.hash
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const getResult = await client.getTransaction(hash)
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw Object.assign(new Error("Soroban transaction failed"), { status: 422 })
      }
      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return hash
      }
    }
  }

  throw Object.assign(new Error("Transaction confirmation timeout"), { status: 504 })
}

// ---------------------------------------------------------------------------
// Event retention
// ---------------------------------------------------------------------------

export interface RetentionWindow {
  oldestLedger: number
  latestLedger?: number
}

/**
 * Recognises the error Soroban RPC returns when getEvents is asked for a
 * ledger outside its retention window, e.g.
 *   "startLedger must be between the oldest ledger: 1200 and the latest ledger: 9800 for this rpc instance."
 * Returns the window when it can be read from the message, `{ oldestLedger: NaN }`
 * when the error is a retention error without numbers, and null otherwise.
 */
export function parseRetentionError(err: unknown): RetentionWindow | null {
  const message =
    typeof err === "string"
      ? err
      : ((err as { message?: string })?.message ??
        (err as { error?: { message?: string } })?.error?.message ??
        "")
  if (!/oldest ledger|out of (the )?retention|ledger range|before the oldest/i.test(message)) {
    return null
  }
  const oldest = message.match(/oldest ledger:?\s*(\d+)/i)
  const latest = message.match(/latest ledger:?\s*(\d+)/i)
  return {
    oldestLedger: oldest ? Number(oldest[1]) : NaN,
    ...(latest ? { latestLedger: Number(latest[1]) } : {}),
  }
}

/**
 * Oldest ledger the RPC node still retains, from getHealth (RPC >= 21
 * reports oldestLedger there). Returns null when the node does not report it.
 */
export async function getOldestRetainedLedger(
  client: { getHealth?: () => Promise<unknown> },
): Promise<number | null> {
  if (!client.getHealth) return null
  const health = (await client.getHealth()) as { oldestLedger?: number }
  return typeof health?.oldestLedger === "number" ? health.oldestLedger : null
}

/**
 * Ledger sequence encoded in a Soroban event paging token. Tokens look like
 * "<toid>-<event index>" where the TOID's upper 32 bits are the ledger.
 */
export function ledgerFromPagingToken(token: string): number | null {
  const toid = token.split("-")[0]
  if (!/^\d+$/.test(toid)) return null
  return Number(BigInt(toid) >> 32n)
}
