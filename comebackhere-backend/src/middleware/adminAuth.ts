import { createHash } from "crypto"
import type { RequestHandler } from "express"
import { ForbiddenError, ServiceMisconfiguredError, UnauthorizedError } from "../lib/errors.js"

export const requireAdmin: RequestHandler = (req, res, next) => {
  const configuredKey = process.env.ADMIN_KEY
  if (!configuredKey) {
    next(new ServiceMisconfiguredError("ADMIN_KEY is not configured"))
    return
  }

  const suppliedKey = req.get("x-admin-key")
  if (!suppliedKey) {
    next(new UnauthorizedError("Admin credentials are required"))
    return
  }
  if (suppliedKey !== configuredKey) {
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
