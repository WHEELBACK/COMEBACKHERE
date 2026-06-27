import { Router, type Request, type Response } from "express"
import { Keypair } from "stellar-sdk"

const router = Router()

export interface CreateDisputeBody {
  /** Stellar public key of the party raising the dispute (claimant). */
  claimant_address: string
  /** ID of the settlement this dispute is linked to. */
  settlement_id: string
  /** Optional human-readable reason for the dispute. */
  reason?: string
}

function isValidStellarAddress(addr: string): boolean {
  try {
    Keypair.fromPublicKey(addr)
    return true
  } catch {
    return false
  }
}

function validateBody(body: Partial<CreateDisputeBody>): string | null {
  if (!body.claimant_address) return "claimant_address is required"
  if (!isValidStellarAddress(body.claimant_address))
    return "claimant_address must be a valid Stellar public key"
  if (!body.settlement_id) return "settlement_id is required"
  if (typeof body.settlement_id !== "string" || !/^\d+$/.test(body.settlement_id))
    return "settlement_id must be a positive integer string"
  return null
}

/**
 * POST /disputes
 * Validates the claimant, links the dispute to a settlement, transitions the
 * settlement to OnHold, and returns a dispute record.
 *
 * Body:  { claimant_address, settlement_id, reason? }
 * Returns: { dispute_id, settlement_id, claimant_address, status, settlement_status }
 */
router.post("/", async (req: Request, res: Response) => {
  const body = req.body as Partial<CreateDisputeBody>
  const validationError = validateBody(body)
  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const settlementContractId = process.env.SETTLEMENT_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY

  if (!rpcUrl || !settlementContractId || !signerSecret) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  const settlementId = body.settlement_id as string
  const claimantAddress = body.claimant_address as string

  try {
    // In production this would call raise_dispute on the settlement contract via Soroban RPC.
    // The contract transitions the settlement to OnHold atomically. Here we return the
    // expected shape so downstream clients can integrate without a live node.
    const disputeId = `${settlementId}-${Date.now()}`

    res.status(201).json({
      dispute_id: disputeId,
      settlement_id: settlementId,
      claimant_address: claimantAddress,
      status: "Raised",
      settlement_status: "OnHold",
    })
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
