import { randomBytes, randomUUID } from "crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { Keypair } from "stellar-sdk"
import { connectMongo, type MerchantApiKeyRecord } from "../db/mongo.js"
import {
  asyncHandler,
  ForbiddenError,
  NotFoundError,
  ServiceMisconfiguredError,
  UnauthorizedError,
} from "../lib/errors.js"
import { hashMerchantApiKey } from "../middleware/apiKey.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { merchantApiKeySchema, merchantApiKeyIdSchema } from "../schemas/index.js"

const router = Router()

/**
 * Middleware allowing either admin credentials (X-Admin-Key) or merchant
 * credentials (X-Merchant-Address or Bearer API key).
 */
export function requireMerchantOrAdmin(req: Request, res: Response, next: NextFunction) {
  const adminKey = req.get("x-admin-key")
  const configuredAdminKey = process.env.ADMIN_KEY

  if (adminKey) {
    if (!configuredAdminKey) {
      next(new ServiceMisconfiguredError("ADMIN_KEY is not configured"))
      return
    }
    if (adminKey !== configuredAdminKey) {
      next(new ForbiddenError("Admin credentials are invalid"))
      return
    }
    res.locals.isAdmin = true
    next()
    return
  }

  // Check merchant address from header, body, or query
  const merchantAddress = (req.get("x-merchant-address") || req.body?.merchant_address || req.query?.merchant_address) as string | undefined
  if (merchantAddress) {
    try {
      Keypair.fromPublicKey(merchantAddress)
      res.locals.merchantAddress = merchantAddress
      res.locals.isAdmin = false
      next()
      return
    } catch {
      next(new ForbiddenError("Invalid merchant Stellar address"))
      return
    }
  }

  // Check bearer token (existing API key)
  const authHeader = req.get("authorization")
  const bearerMatch = authHeader?.match(/^Bearer (\S+)$/i)
  if (bearerMatch) {
    void (async () => {
      const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
      const record = await keys.findOne({ key_hash: hashMerchantApiKey(bearerMatch[1]), revoked_at: { $exists: false } })
      if (!record) throw new UnauthorizedError("Merchant API key is invalid or revoked")
      res.locals.merchantAddress = record.merchant_address
      res.locals.isAdmin = false
      next()
    })().catch(next)
    return
  }

  next(new UnauthorizedError("Merchant address (X-Merchant-Address) or Admin credentials (X-Admin-Key) required"))
}

/**
 * @openapi
 * /api/merchant-keys:
 *   get:
 *     tags: [Merchant Authentication]
 *     summary: Inspect API key metadata for an authorized merchant
 *     parameters:
 *       - in: query
 *         name: merchant_address
 *         required: false
 *         schema: { type: string, example: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX }
 *       - in: header
 *         name: X-Merchant-Address
 *         required: false
 *         schema: { type: string }
 *       - in: header
 *         name: X-Admin-Key
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of API key metadata; secret keys and hashes are omitted
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   key_id: { type: string, format: uuid }
 *                   merchant_address: { type: string }
 *                   created_at: { type: string, format: date-time }
 *                   revoked_at: { type: string, format: date-time, nullable: true }
 *                   last_used_at: { type: string, format: date-time, nullable: true }
 *                   is_active: { type: boolean }
 *       401:
 *         description: Merchant authorization or admin credentials are required
 *       403:
 *         description: Credentials or address invalid
 */
router.get("/", requireMerchantOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  const targetMerchant = res.locals.isAdmin
    ? (typeof req.query.merchant_address === "string" ? req.query.merchant_address : undefined)
    : res.locals.merchantAddress

  const filter: Record<string, unknown> = {}
  if (targetMerchant) {
    filter.merchant_address = targetMerchant
  } else if (!res.locals.isAdmin) {
    throw new UnauthorizedError("Merchant address is required")
  }

  const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
  const records = await keys.find(filter).sort({ created_at: -1 }).toArray()

  const metadata = records.map((r) => ({
    key_id: r.key_id,
    merchant_address: r.merchant_address,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    is_active: !r.revoked_at,
  }))

  res.json(metadata)
}))

/**
 * @openapi
 * /api/merchant-keys:
 *   post:
 *     tags: [Merchant Authentication]
 *     summary: Create a merchant API key (plaintext returned only at creation)
 *     parameters:
 *       - in: header
 *         name: X-Merchant-Address
 *         required: false
 *         schema: { type: string }
 *       - in: header
 *         name: X-Admin-Key
 *         required: false
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
 *               rotate: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: API key created; plaintext secret is returned only once
 *       401:
 *         description: Merchant authorization or admin credentials missing
 *       403:
 *         description: Credentials or address invalid
 */
router.post("/", requireMerchantOrAdmin, validateBody(merchantApiKeySchema), asyncHandler(async (req: Request, res: Response) => {
  const merchantAddress = req.body.merchant_address as string
  if (!res.locals.isAdmin && res.locals.merchantAddress && res.locals.merchantAddress !== merchantAddress) {
    throw new ForbiddenError("Cannot create key for another merchant address")
  }

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

  if (req.body.rotate) {
    await keys.updateMany(
      { merchant_address: merchantAddress, key_id: { $ne: keyId }, revoked_at: { $exists: false } },
      { $set: { revoked_at: createdAt } },
    )
  }

  res.status(201).json({
    key_id: keyId,
    merchant_address: merchantAddress,
    api_key: key,
    created_at: createdAt,
    is_active: true,
  })
}))

/**
 * @openapi
 * /api/merchant-keys/rotate:
 *   post:
 *     tags: [Merchant Authentication]
 *     summary: Rotate a merchant API key (revokes current active keys and generates a new one)
 *     parameters:
 *       - in: header
 *         name: X-Merchant-Address
 *         required: false
 *         schema: { type: string }
 *       - in: header
 *         name: X-Admin-Key
 *         required: false
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
 *         description: API key rotated; new plaintext secret is returned only once
 *       401:
 *         description: Merchant authorization or admin credentials missing
 *       403:
 *         description: Credentials or address invalid
 */
router.post("/rotate", requireMerchantOrAdmin, validateBody(merchantApiKeySchema), asyncHandler(async (req: Request, res: Response) => {
  const merchantAddress = req.body.merchant_address as string
  if (!res.locals.isAdmin && res.locals.merchantAddress && res.locals.merchantAddress !== merchantAddress) {
    throw new ForbiddenError("Cannot rotate key for another merchant address")
  }

  const key = `ch_${randomBytes(32).toString("hex")}`
  const keyId = randomUUID()
  const rotatedAt = new Date()
  const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")

  await keys.insertOne({
    key_id: keyId,
    merchant_address: merchantAddress,
    key_hash: hashMerchantApiKey(key),
    created_at: rotatedAt,
  })

  await keys.updateMany(
    { merchant_address: merchantAddress, key_id: { $ne: keyId }, revoked_at: { $exists: false } },
    { $set: { revoked_at: rotatedAt } },
  )

  res.status(201).json({
    key_id: keyId,
    merchant_address: merchantAddress,
    api_key: key,
    created_at: rotatedAt,
    rotated_at: rotatedAt,
    is_active: true,
  })
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
 *         name: X-Merchant-Address
 *         required: false
 *         schema: { type: string }
 *       - in: header
 *         name: X-Admin-Key
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: API key revoked
 *       401:
 *         description: Credentials or authorization missing
 *       403:
 *         description: Not authorized to revoke this key
 *       404:
 *         description: Active key not found
 */
router.delete("/:keyId", requireMerchantOrAdmin, validateParams(merchantApiKeyIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
  const record = await keys.findOne({ key_id: req.params.keyId })
  if (!record || record.revoked_at) {
    throw new NotFoundError("Active merchant API key not found")
  }

  if (!res.locals.isAdmin && res.locals.merchantAddress && record.merchant_address !== res.locals.merchantAddress) {
    throw new ForbiddenError("You are not authorized to revoke this key")
  }

  await keys.updateOne(
    { key_id: req.params.keyId },
    { $set: { revoked_at: new Date() } },
  )

  res.status(204).end()
}))

export default router
