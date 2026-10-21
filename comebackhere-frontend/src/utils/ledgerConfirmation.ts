/**
 * Waits until a submitted transaction is actually included in a ledger before
 * the UI reports success. `sendTransaction` only acknowledges submission.
 */
interface TxLookup {
  getTransaction: (hash: string) => Promise<{ status: string }>
}

export async function waitForLedgerConfirmation(
  server: TxLookup,
  hash: string,
  { timeoutMs = 30_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tx = await server.getTransaction(hash)
    if (tx.status === "SUCCESS") return
    if (tx.status === "FAILED") throw new Error("Transaction failed on the ledger")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error("Transaction was submitted but not yet confirmed on the ledger. Check again shortly.")
}
