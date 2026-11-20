/**
 * Correlation ID middleware (issue #224)
 *
 * Attaches a unique `X-Request-Id` header to every request and response so
 * that a single request can be traced across logs, the treasury indexer, and
 * webhook delivery.
 *
 * Behaviour:
 *  - If the incoming request already carries an `X-Request-Id` header, that
 *    value is preserved and echoed back on the response (client-supplied ID).
 *  - Otherwise a new UUID v4 is generated and set on both the request and the
 *    response.
 *
 * The ID is stored on `res.locals.requestId` so route handlers and other
 * middleware can include it in log lines:
 *
 *   res.locals.logger.info({ invoiceId }, "Processing invoice")
 */

import { type Request, type Response, type NextFunction } from "express"
import { randomUUID } from "node:crypto"
import { logger } from "../lib/logger.js"

const MAX_REQUEST_ID_LENGTH = 128
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:\-]+$/

/** Client-supplied IDs end up in logs and headers: bound length and charset. */
export function isSafeRequestId(value: string): boolean {
  return value.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(value)
}

export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.headers["x-request-id"]
  // Only accept a single string value; ignore arrays (malformed headers)
  const requestId =
    typeof incomingId === "string" && incomingId.trim() !== "" && isSafeRequestId(incomingId.trim())
      ? incomingId.trim()
      : randomUUID()

  // Make the ID available to downstream handlers and logging
  res.locals.requestId = requestId
  res.locals.logger = logger.child({ correlationId: requestId })

  // Echo the ID on the response so callers can correlate client-side
  res.setHeader("X-Request-Id", requestId)

  next()
}
