import { createHash, timingSafeEqual } from "crypto"
import type { RequestHandler } from "express"
import { connectMongo, type MerchantApiKeyRecord } from "../db/mongo.js"
import { UnauthorizedError } from "../lib/errors.js"
import { logger } from "../lib/logger.js"

export function hashMerchantApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Upper bound on bearer token length; real keys are far shorter, so longer values are rejected before hashing or DB access. */
export const MAX_API_KEY_LENGTH = 256

/** Minimum length for a merchant API key; shorter values are rejected before hashing or DB access. */
export const MIN_API_KEY_LENGTH = 16

/** Only allow URL-safe token characters to avoid header/encoding injection and malformed hashes. */
const API_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]+$/

/** Constant-time comparison of two hex digests to avoid timing side channels. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

export const requireMerchantApiKey: RequestHandler = (req, res, next) => {
  const authorization = req.get("authorization")
  const match = authorization?.match(/^Bearer (\S+)$/i)
  if (!match) {
    next(new UnauthorizedError("A merchant API key is required"))
    return
  }

  const token = match[1]
  if (
    token.length < MIN_API_KEY_LENGTH ||
    token.length > MAX_API_KEY_LENGTH ||
    !API_KEY_PATTERN.test(token)
  ) {
    next(new UnauthorizedError("A merchant API key is required"))
    return
  }

  void (async () => {
    const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
    const keyHash = hashMerchantApiKey(token)
    const record = await keys.findOne({ key_hash: keyHash, revoked_at: { $exists: false } })
    if (!record || typeof record.key_hash !== "string" || !safeEqualHex(record.key_hash, keyHash)) {
      throw new UnauthorizedError("Merchant API key is invalid or revoked")
    }
    if (typeof record.merchant_address !== "string" || record.merchant_address.length === 0) {
      logger.error({ key_id: record.key_id }, "Merchant API key record missing merchant_address")
      throw new UnauthorizedError("Merchant API key is invalid or revoked")
    }
    res.locals.merchantAddress = record.merchant_address
    void keys.updateOne({ key_id: record.key_id }, { $set: { last_used_at: new Date() } }).catch((err: unknown) => {
      logger.error({ err, key_id: record.key_id }, "Failed to update merchant API key last_used_at")
    })
    next()
  })().catch(next)
}