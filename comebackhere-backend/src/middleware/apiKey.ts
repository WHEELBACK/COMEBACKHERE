import { createHash } from "crypto"
import type { RequestHandler } from "express"
import { connectMongo, type MerchantApiKeyRecord } from "../db/mongo.js"
import { UnauthorizedError } from "../lib/errors.js"
import { logger } from "../lib/logger.js"

export function hashMerchantApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export const requireMerchantApiKey: RequestHandler = (req, res, next) => {
  const authorization = req.get("authorization")
  const match = authorization?.match(/^Bearer (\S+)$/i)
  if (!match) {
    next(new UnauthorizedError("A merchant API key is required"))
    return
  }

  void (async () => {
    const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
    const record = await keys.findOne({ key_hash: hashMerchantApiKey(match[1]), revoked_at: { $exists: false } })
    if (!record) throw new UnauthorizedError("Merchant API key is invalid or revoked")
    res.locals.merchantAddress = record.merchant_address
    void keys.updateOne({ key_id: record.key_id }, { $set: { last_used_at: new Date() } }).catch((err: unknown) => {
      logger.error({ err, key_id: record.key_id }, "Failed to update merchant API key last_used_at")
    })
    next()
  })().catch(next)
}
