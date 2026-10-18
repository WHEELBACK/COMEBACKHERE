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
          field: issue.path.join("."),
          message: issue.message,
        }))
        const message = details.map((d) => `${d.field}: ${d.message}`).join("; ")
        next(new ValidationError(message, details))
        return
      }
      if (part === "body") {
        req.body = result.data
      }
      next()
    }
}

export const validateBody = makeValidator("body")
export const validateParams = makeValidator("params")
export const validateQuery = makeValidator("query")
