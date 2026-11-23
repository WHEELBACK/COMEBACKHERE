import { createHash, timingSafeEqual } from "crypto"
import type { RequestHandler } from "express"
import { ForbiddenError, ServiceMisconfiguredError, UnauthorizedError } from "../lib/errors.js"

const MAX_ADMIN_KEY_LENGTH = 512
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/** Constant-time comparison; hashing first equalises lengths so none leaks. */
export function safeKeyEquals(supplied: string, configured: string): boolean {
  const a = createHash("sha256").update(supplied).digest()
  const b = createHash("sha256").update(configured).digest()
  return timingSafeEqual(a, b)
}

/** Rejects keys that are empty, whitespace-only, oversized or contain control characters. */
export function isWellFormedKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_ADMIN_KEY_LENGTH) return false
  if (key.trim().length === 0) return false
  if (CONTROL_CHARACTER_PATTERN.test(key)) return false
  return true
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  const configuredKey = process.env.ADMIN_KEY
  if (!configuredKey || !isWellFormedKey(configuredKey)) {
    next(new ServiceMisconfiguredError("ADMIN_KEY is not configured"))
    return
  }

  const suppliedKey = req.get("x-admin-key")
  if (!suppliedKey) {
    next(new UnauthorizedError("Admin credentials are required"))
    return
  }
  if (!isWellFormedKey(suppliedKey) || !safeKeyEquals(suppliedKey, configuredKey)) {
    next(new ForbiddenError("Admin credentials are invalid"))
    return
  }

  const keyFingerprint = createHash("sha256").update(configuredKey).digest("hex").slice(0, 12)
  const adminIdentity = process.env.ADMIN_IDENTITY ?? `admin-${keyFingerprint}`
  res.locals.adminIdentity = adminIdentity
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "-"
  console.info(`[admin-audit] requestId=${requestId} admin=${adminIdentity} action=${req.method} ${req.path}`)
  next()
}
