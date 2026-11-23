import { z } from "zod"
import type { Request, Response, NextFunction } from "express"
import { ValidationError } from "../lib/errors.js"

type RequestPart = "body" | "params" | "query"

// Hard limits to protect against oversized / abusive payloads.
export const MAX_STRING_LENGTH = 10_000
export const MAX_ARRAY_LENGTH = 1_000
export const MAX_OBJECT_KEYS = 1_000
export const MAX_DEPTH = 20

// Control characters (C0 except \t \n \r, plus DEL and C1 range) that have no
// legitimate place in structured input and are commonly used to smuggle
// injection payloads past naive filters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Recursively strip control characters from all string values in a parsed
 * payload. Returns a new structure; the input is not mutated.
 */
export function stripControlChars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(CONTROL_CHARS_RE, "") as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripControlChars(item)) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[stripControlChars(key)] = stripControlChars(val)
    }
    return out as unknown as T
  }
  return value
}

/**
 * Enforce structural limits (depth, array length, object key count, string
 * length) on a parsed value. Returns an error message on the first violation,
 * or null when the value is within bounds.
 */
export function checkStructuralLimits(
  value: unknown,
  depth = 0,
  path = "(root)",
): string | null {
  if (depth > MAX_DEPTH) {
    return `${path}: exceeds maximum nesting depth of ${MAX_DEPTH}`
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return `${path}: exceeds maximum length of ${MAX_STRING_LENGTH}`
    }
    return null
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      return `${path}: exceeds maximum array length of ${MAX_ARRAY_LENGTH}`
    }
    for (let i = 0; i < value.length; i++) {
      const err = checkStructuralLimits(value[i], depth + 1, `${path}.${i}`)
      if (err) return err
    }
    return null
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_OBJECT_KEYS) {
      return `${path}: exceeds maximum key count of ${MAX_OBJECT_KEYS}`
    }
    for (const [key, val] of entries) {
      const err = checkStructuralLimits(val, depth + 1, `${path}.${key}`)
      if (err) return err
    }
    return null
  }
  return null
}

function makeValidator(part: RequestPart) {
  return (schema: z.ZodTypeAny) =>
    (req: Request, _res: Response, next: NextFunction) => {
      // Guard against prototype-pollution style keys before parsing.
      const raw = req[part]
      if (raw !== null && typeof raw === "object") {
        const structuralError = checkStructuralLimits(raw)
        if (structuralError) {
          next(
            new ValidationError(structuralError, [
              {
                field: structuralError.split(":")[0] ?? "(root)",
                message: structuralError.split(":").slice(1).join(":").trim(),
              },
            ]),
          )
          return
        }
      }

      const result = schema.safeParse(raw)
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : "(root)",
          message: issue.message,
        }))
        const message = details.map((d) => `${d.field}: ${d.message}`).join("; ")
        next(new ValidationError(message, details))
        return
      }

      // Strip control characters from the validated output so downstream
      // handlers never see smuggled payloads.
      const sanitized = stripControlChars(result.data)

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