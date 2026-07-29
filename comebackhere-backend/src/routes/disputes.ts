import { Router, type Request, type Response } from "express"
import { Keypair } from "stellar-sdk"
import { validate, createDisputeSchema, disputeVoteSchema } from "../middleware/validation.js"
import { recordVote } from "../lib/vote-tracker.js"

const router = Router()

export interface CreateDisputeBody {
  claimant_address: string
  settlement_id: string
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

/**
 * POST /disputes
 * Body: { claimant_address, settlement_id, reason? }
 * Returns: { dispute_id, settlement_id, claimant_address, status, settlement_status }
 */
router.post("/", validate(createDisputeSchema), async (req: Request, res: Response) => {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const settlementContractId = process.env.SETTLEMENT_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY

  if (!rpcUrl || !settlementContractId || !signerSecret) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  const settlementId = req.body.settlement_id as string
  const claimantAddress = req.body.claimant_address as string

  try {
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

/**
 * POST /disputes/:id/vote
 * Body: { signer_address, weight }
 *
 * Rejects duplicate votes from the same signer.
 * Accumulates weight across distinct signers.
 */
router.post("/:id/vote", validate(disputeVoteSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const signerAddress = req.body.signer_address as string
    const weight = req.body.weight as number

    const result = recordVote(id, signerAddress, weight)

    if (!result.accepted) {
      res.status(409).json({
        error: "Duplicate vote",
        dispute_id: id,
        signer_address: signerAddress,
        total_weight: result.totalWeight,
      })
      return
    }

    res.status(200).json({
      dispute_id: id,
      signer_address: signerAddress,
      weight,
      total_weight: result.totalWeight,
      status: "Voting",
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

export default router
