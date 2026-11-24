/**
 * Reporting-engine security helpers.
 *
 * Provides:
 *  - requireReportAccess  — Express middleware that enforces merchant-scoped auth
 *  - sanitizeReportQuery  — strips dangerous characters from free-text query strings
 *  - assertSafeReportFilter — validates plain-object filters, rejecting operator
 *                             injection, prototype pollution, and excessive nesting
 */

import type { Request, Response, NextFunction } from "express"
import { ValidationError, ForbiddenError } from "../lib/errors.js"

/** Maximum byte length of a free-text report query string. */
export const MAX_REPORT_QUERY_LENGTH = 1024

/** Maximum nesting depth for a structured report filter object. */
export const MAX_REPORT_FILTER_DEPTH = 5

// ---------------------------------------------------------------------------
// requireReportAccess
// ---------------------------------------------------------------------------

/**
 * Middleware that ensures the request is authenticated and that the caller is
 * accessing their own merchant data only.
 *
 * Expects `req.user` to carry `{ id: string; merchantId?: string }` and
 * `req.params.merchantId` to hold the target merchant.
 */
export function requireReportAccess(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as { id?: string; merchantId?: string } | undefined

  if (!user || !user.id) {
    next(Object.assign(new Error("Authentication required"), { status: 401 }))
    return
  }

  if (!user.merchantId) {
    next(Object.assign(new Error("Merchant scope required"), { status: 403 }))
    return
  }

  const targetMerchantId = (req.params as any).merchantId
  if (targetMerchantId !== undefined && targetMerchantId !== user.merchantId) {
    next(Object.assign(new Error("Access denied: cross-merchant access is not permitted"), { status: 403 }))
    return
  }

  next()
}

// ---------------------------------------------------------------------------
// sanitizeReportQuery
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-text report query string.
 *
 * - Rejects non-strings and inputs exceeding MAX_REPORT_QUERY_LENGTH.
 * - Strips ASCII control characters (0x00–0x1f, 0x7f) and trims whitespace.
 * - Removes MongoDB-style operator tokens ($ prefix) to neutralize injection.
 */
export function sanitizeReportQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Report query must be a string")
  }
  if (raw.length > MAX_REPORT_QUERY_LENGTH) {
    throw new ValidationError(
      `Report query must not exceed ${MAX_REPORT_QUERY_LENGTH} characters`,
    )
  }

  // Strip control characters, then remove any $ operator tokens.
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    // Remove MongoDB-style operators: standalone $tokens and quoted "$key" patterns.
    .replace(/"\$[^"]*"/g, '""')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "")

  return stripped
}

// ---------------------------------------------------------------------------
// assertSafeReportFilter
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Validate a structured report filter object.
 *
 * Throws ValidationError when the filter:
 *  - is not a plain (non-array, non-Date, non-null) object
 *  - contains MongoDB operator keys (starting with $)
 *  - contains prototype-pollution keys (__proto__, constructor, prototype)
 *  - exceeds MAX_REPORT_FILTER_DEPTH nesting levels
 */
export function assertSafeReportFilter(
  filter: Record<string, unknown>,
  depth = 0,
): void {
  if (
    filter === null ||
    typeof filter !== "object" ||
    Array.isArray(filter) ||
    filter instanceof Date
  ) {
    throw new ValidationError("Report filter must be a plain object")
  }

  if (depth > MAX_REPORT_FILTER_DEPTH) {
    throw new ValidationError(
      `Report filter must not be nested more than ${MAX_REPORT_FILTER_DEPTH} levels deep`,
    )
  }

  // Check for prototype pollution: test whether constructing from the object
  // would change Object.prototype or Function.prototype.
  if (
    Object.getPrototypeOf(filter) !== Object.prototype &&
    Object.getPrototypeOf(filter) !== null
  ) {
    throw new ValidationError("Report filter contains a forbidden key")
  }

  // Also guard against `constructor` as an own key (e.g. { constructor: {} })
  // which may be an enumerable own property in some JavaScript environments.
  if (Object.prototype.hasOwnProperty.call(filter, "constructor")) {
    throw new ValidationError("Report filter contains a forbidden key: constructor")
  }

  for (const key of Object.keys(filter)) {
    if (key.startsWith("$")) {
      throw new ValidationError(`Report filter contains a disallowed operator key: ${key}`)
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError(`Report filter contains a forbidden key: ${key}`)
    }
    const value = filter[key]
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      assertSafeReportFilter(value as Record<string, unknown>, depth + 1)
    }
  }
}
