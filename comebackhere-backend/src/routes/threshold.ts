import { Router, type Request, type Response } from "express"
import { Keypair, nativeToScVal } from "stellar-sdk"
import {
  buildSorobanClient,
  simulateContractRead,
  submitContractCall,
  type SorobanClient,
} from "../lib/soroban.js"
import { requireEnv } from "../lib/env.js"
import { asyncHandler } from "../lib/errors.js"
import { validateBody } from "../middleware/validate.js"
import { thresholdSchema } from "../schemas/index.js"

const router = Router()

/**
 * GET /api/treasury/threshold
 * Returns the current approval threshold from the treasury contract.
 */
router.get("/threshold", asyncHandler(async (_req: Request, res: Response) => {
  const env = requireEnv({
    treasuryContractId: "TREASURY_CONTRACT_ID",
    signerSecret: "SIGNER_SECRET_KEY",
  })

  const client = buildSorobanClient(env.rpcUrl)
  const sourceAccount = Keypair.fromSecret(env.signerSecret).publicKey()
  const retval = await simulateContractRead(
    client,
    env.treasuryContractId,
    "get_threshold",
    [],
    sourceAccount,
    env.networkPassphrase,
  )
  const threshold = Number(retval.u64()?.toString() ?? "0")
  res.json({ threshold })
}))

/**
 * POST /api/treasury/threshold
 * Body: { threshold: number } — must be a positive integer
 * Updates the treasury approval threshold via update_threshold.
 */
export async function setThreshold(
  threshold: number,
  env: {
    rpcUrl: string
    treasuryContractId: string
    signerSecret: string
    networkPassphrase: string
  },
  clientOverride?: SorobanClient,
): Promise<{ threshold: number; tx_hash: string }> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)

  const txHash = await submitContractCall(
    client,
    env.treasuryContractId,
    "update_threshold",
    [
      nativeToScVal(keypair.publicKey(), { type: "address" }),
      nativeToScVal(threshold, { type: "u32" }),
    ],
    env.signerSecret,
    env.networkPassphrase,
  )

  return { threshold, tx_hash: txHash }
}

router.post("/threshold", validateBody(thresholdSchema), asyncHandler(async (req: Request, res: Response) => {
  const env = requireEnv({
    treasuryContractId: "TREASURY_CONTRACT_ID",
    signerSecret: "SIGNER_SECRET_KEY",
  })

  const threshold = req.body.threshold

  const result = await setThreshold(threshold, env)
  res.json(result)
}))

export default router
