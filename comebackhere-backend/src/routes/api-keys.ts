import { randomBytes, randomUUID } from "crypto"
import { Router, type Request, type Response } from "express"
import { connectMongo, type MerchantApiKeyRecord } from "../db/mongo.js"
import { asyncHandler, NotFoundError } from "../lib/errors.js"
import { requireAdmin } from "../middleware/adminAuth.js"
import { hashMerchantApiKey } from "../middleware/apiKey.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { merchantApiKeySchema, merchantApiKeyIdSchema } from "../schemas/index.js"

const router = Router()

/**
 * @openapi
 * /api/merchant-keys:
 *   post:
 *     tags: [Merchant Authentication]
 *     summary: Create or rotate a merchant API key
 *     parameters:
 *       - in: header
 *         name: X-Admin-Key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [merchant_address]
 *             properties:
 *               merchant_address: { type: string, example: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX }
 *     responses:
 *       201:
 *         description: API key created; plaintext is returned only once
 *       401:
 *         description: Admin credentials are missing
 *       403:
 *         description: Admin credentials are invalid
 */
router.post("/", requireAdmin, validateBody(merchantApiKeySchema), asyncHandler(async (req: Request, res: Response) => {
  const merchantAddress = req.body.merchant_address as string
  const key = `ch_${randomBytes(32).toString("hex")}`
  const keyId = randomUUID()
  const createdAt = new Date()
  const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")

  await keys.insertOne({
    key_id: keyId,
    merchant_address: merchantAddress,
    key_hash: hashMerchantApiKey(key),
    created_at: createdAt,
  })
  await keys.updateMany(
    { merchant_address: merchantAddress, key_id: { $ne: keyId }, revoked_at: { $exists: false } },
    { $set: { revoked_at: createdAt } },
  )

  res.status(201).json({ key_id: keyId, merchant_address: merchantAddress, api_key: key, created_at: createdAt })
}))

/**
 * @openapi
 * /api/merchant-keys/{keyId}:
 *   delete:
 *     tags: [Merchant Authentication]
 *     summary: Revoke a merchant API key
 *     parameters:
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: X-Admin-Key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: API key revoked
 *       401:
 *         description: Admin credentials are missing
 *       403:
 *         description: Admin credentials are invalid
 *       404:
 *         description: Active key not found
 */
router.delete("/:keyId", requireAdmin, validateParams(merchantApiKeyIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
  const result = await keys.updateOne(
    { key_id: req.params.keyId, revoked_at: { $exists: false } },
    { $set: { revoked_at: new Date() } },
  )
  if (result.matchedCount === 0) throw new NotFoundError("Active merchant API key not found")
  res.status(204).end()
}))

export default router
