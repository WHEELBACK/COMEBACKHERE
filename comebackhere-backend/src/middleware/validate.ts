import { z } from "zod"
import type { Request, Response, NextFunction } from "express"
import { ValidationError } from "../lib/errors.js"

type RequestPart = "body" | "params" | "query"

function makeValidator(part: RequestPart) {
  return (schema: z.ZodTypeAny) =>
    (req: Request, _res: Response, next: NextFunction) => {
      const result = schema.safeParse(req[part])
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : "(root)",
          message: issue.message,
        }))
        const message = details.map((d) => `${d.field}: ${d.message}`).join("; ")
        next(new ValidationError(message, details))
        return
      }
      if (part === "body") {
        req.body = result.data
      } else if (part === "params") {
        // Apply coerced/stripped params; req.query is a read-only getter in Express 5, so it is left as-is.
        req.params = result.data as Request["params"]
      }
      next()
    }
}

export const validateBody = makeValidator("body")
export const validateParams = makeValidator("params")
export const validateQuery = makeValidator("query")
