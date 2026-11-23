import { createHash } from "crypto"
import type { RequestHandler } from "express"
import { connectMongo, type MerchantApiKeyRecord } from "../db/mongo.js"
import { UnauthorizedError } from "../lib/errors.js"
import { logger } from "../lib/logger.js"

export function hashMerchantApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Upper bound on bearer token length; real keys are far shorter, so longer values are rejected before hashing or DB access. */
export const MAX_API_KEY_LENGTH = 256

/** Matches a single Bearer token with no whitespace, control characters, or extra tokens. */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i

/** Rejects any string containing ASCII control characters (0x00-0x1F, 0x7F). */
function containsControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/.test(value)
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  if (containsControlCharacters(authorization)) return null
  const match = authorization.match(BEARER_PATTERN)
  if (!match) return null
  const token = match[1]
  if (token.length === 0 || token.length > MAX_API_KEY_LENGTH) return null
  return token
}

function isRecordActive(record: MerchantApiKeyRecord): boolean {
  if (record.revoked_at) return false
  const expiresAt = (record as { expires_at?: Date | string | null }).expires_at
  if (expiresAt) {
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) return false
  }
  return true
}

export const requireMerchantApiKey: RequestHandler = (req, res, next) => {
  const token = extractBearerToken(req.get("authorization"))
  if (!token) {
    next(new UnauthorizedError("A merchant API key is required"))
    return
  }

  void (async () => {
    let record: MerchantApiKeyRecord | null
    try {
      const keys = (await connectMongo()).collection<MerchantApiKeyRecord>("merchant_api_keys")
      record = await keys.findOne({ key_hash: hashMerchantApiKey(token), revoked_at: { $exists: false } })
      if (!record || !isRecordActive(record)) {
        throw new UnauthorizedError("Merchant API key is invalid or revoked")
      }
      res.locals.merchantAddress = record.merchant_address
      void keys.updateOne({ key_id: record.key_id }, { $set: { last_used_at: new Date() } }).catch((err: unknown) => {
        logger.error({ err, key_id: record?.key_id }, "Failed to update merchant API key last_used_at")
      })
      next()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        next(err)
        return
      }
      logger.error({ err }, "Merchant API key lookup failed")
      next(new UnauthorizedError("Merchant API key is invalid or revoked"))
    }
  })()
}