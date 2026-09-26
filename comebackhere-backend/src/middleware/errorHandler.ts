import type { NextFunction, Request, Response } from "express"
import {
  AppError,
  ContractError,
  NotFoundError,
  PayloadTooLargeError,
  parseContractErrorCode,
} from "../lib/errors.js"

/**
 * Standard error envelope returned by every route:
 *
 *   { error: { code, message, details, correlationId } }
 */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details: unknown
    correlationId: string | null
  }
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
}

/**
 * Normalises anything thrown by a route into an {@link AppError}.
 *
 * Legacy helpers still throw plain `Error`s tagged with `status`; body-parser
 * errors carry `status` and `type`. Soroban host errors that embed
 * `Error(Contract, #N)` become a {@link ContractError} with that code.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err

  const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown; limit?: unknown }
  const rawStatus = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500
  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const message = err instanceof Error ? err.message : typeof e.message === "string" ? e.message : String(err)

  if (e.type === "entity.too.large") {
    return new PayloadTooLargeError(undefined, typeof e.limit === "number" ? { limitBytes: e.limit } : null)
  }
  if (e.type === "entity.parse.failed") {
    return new AppError(400, "INVALID_JSON", "Request body is not valid JSON")
  }

  const contractCode = parseContractErrorCode(message)
  if (contractCode !== null) {
    return new ContractError(contractCode, message, status === 500 ? 422 : status)
  }

  return new AppError(status, CODE_BY_STATUS[status] ?? (status < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR"), message)
}

export function buildErrorEnvelope(err: AppError, correlationId: string | null): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      details: err.details ?? null,
      correlationId,
    },
  }
}

/** Catch-all for unmatched routes — mounted after every router. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`))
}

/** Central Express error handler — must be registered last. */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err)
    return
  }

  const appError = toAppError(err)
  const correlationId = typeof res.locals.requestId === "string" ? res.locals.requestId : null

  if (appError.status >= 500) {
    console.error(`[requestId=${correlationId}] ${appError.code}: ${appError.message}`)
  }

  res.status(appError.status).json(buildErrorEnvelope(appError, correlationId))
}
