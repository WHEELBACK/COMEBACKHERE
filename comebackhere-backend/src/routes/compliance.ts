import { Router, type Request, type Response } from "express"
import { Keypair, Networks, nativeToScVal, Address, xdr } from "stellar-sdk"
import { buildSorobanClient, getNetworkPassphrase, simulateContractRead } from "../lib/soroban.js"

const router = Router()

function isValidStellarAddress(addr: string): boolean {
  try {
    Keypair.fromPublicKey(addr)
    return true
  } catch {
    return false
  }
}

type ComplianceStatus = "Allowed" | "AllowedUntil" | "Blocked" | "Cleared"

interface ComplianceResult {
  address: string
  status: ComplianceStatus
  allowed: boolean
  expires_at: number | null
}

function parseAddressStatus(retval: xdr.ScVal): { status: ComplianceStatus; expiresAt: number | null } {
  const vec = retval.vec()
  const variant = (vec?.[0]?.sym()?.toString() ?? "Cleared") as ComplianceStatus
  if (variant === "AllowedUntil") {
    const raw = vec?.[1]?.u64()
    const expiresAt = raw ? Number(raw.toString()) : null
    return { status: variant, expiresAt }
  }
  return { status: variant, expiresAt: null }
}

/**
 * GET /compliance/:address
 * Returns compliance status for a Stellar address: allowed, blocked, or expired allowance.
 */
router.get("/:address", async (req: Request, res: Response) => {
  const { address } = req.params

  if (!isValidStellarAddress(address)) {
    res.status(400).json({ error: "Invalid Stellar address format" })
    return
  }

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const complianceContractId = process.env.COMPLIANCE_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY

  if (!rpcUrl || !complianceContractId || !signerSecret) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  try {
    const client = buildSorobanClient(rpcUrl)
    const { Keypair: KP } = await import("stellar-sdk")
    const sourceAccount = KP.fromSecret(signerSecret).publicKey()
    const networkPassphrase = getNetworkPassphrase()

    const retval = await simulateContractRead(
      client,
      complianceContractId,
      "get_address_status",
      [nativeToScVal(Address.fromString(address), { type: "address" })],
      sourceAccount,
      networkPassphrase,
    )

    const { status, expiresAt } = parseAddressStatus(retval)

    const now = Math.floor(Date.now() / 1000)
    const expired = status === "AllowedUntil" && expiresAt !== null && expiresAt < now

    const result: ComplianceResult = {
      address,
      status: expired ? "Blocked" : status,
      allowed: (status === "Allowed" || (status === "AllowedUntil" && !expired)),
      expires_at: expiresAt,
    }

    res.json(result)
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
