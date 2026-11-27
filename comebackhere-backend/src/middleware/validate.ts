import { z } from "zod"
import type { Request, Response, NextFunction } from "express"
import { ValidationError } from "../lib/errors.js"

type RequestPart = "body" | "params" | "query"

/**
 * Recursively sanitize string values to defend against injection attacks.
 * - Strips ASCII control characters (except common whitespace: \t, \n, \r).
 * - Removes NUL bytes.
 * - Trims leading/trailing whitespace.
 * Non-string primitives are returned unchanged. Arrays and plain objects are
 * traversed recursively. Other object types (e.g. Date, Buffer) are returned as-is.
 */
function sanitizeString(value: string): string {
  // Remove NUL bytes and other control characters that have no legitimate
  // place in user-supplied input. Keep \t (0x09), \n (0x0A), \r (0x0D).
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  return stripped.trim()
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeString(value)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  if (seen.has(value as object)) {
    // Guard against circular references.
    return value
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen))
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    // Leave non-plain objects (Date, Buffer, etc.) untouched.
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeValue(val, seen)
  }
  return result
}

function sanitize<T>(value: T): T {
  return sanitizeValue(value, new WeakSet<object>()) as T
}

function makeValidator(part: RequestPart) {
  return (schema: z.ZodTypeAny) =>
    (req: Request, _res: Response, next: NextFunction) => {
      let result: z.SafeParseReturnType<unknown, unknown>
      try {
        result = schema.safeParse(req[part])
      } catch (err) {
        // Defensive: a schema that throws unexpectedly should surface as a
        // validation error rather than crashing the request pipeline.
        next(new ValidationError("Invalid request input", [{ field: "(root)", message: "validation failed" }]))
        return
      }

      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : "(root)",
          message: issue.message,
        }))
        const message = details.map((d) => `${d.field}: ${d.message}`).join("; ")
        next(new ValidationError(message, details))
        return
      }

      const sanitized = sanitize(result.data)

      if (part === "body") {
        req.body = sanitized
      } else if (part === "params") {
        // Apply coerced/stripped params; req.query is a read-only getter in Express 5, so it is left as-is.
        req.params = sanitized as Request["params"]
      }
      next()
    }
}

export const validateBody = makeValidator("body")
export const validateParams = makeValidator("params")
export const validateQuery = makeValidator("query")