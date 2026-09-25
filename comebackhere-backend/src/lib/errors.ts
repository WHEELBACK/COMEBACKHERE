import type { NextFunction, Request, RequestHandler, Response } from "express"

/**
 * Typed application errors.
 *
 * Routes throw one of these instead of building error responses by hand; the
 * central handler in `middleware/errorHandler.ts` turns them into the standard
 * envelope:
 *
 *   { error: { code, message, details, correlationId } }
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface FieldIssue {
  field: string
  message: string
}

export class ValidationError extends AppError {
  constructor(message: string, details: FieldIssue[] | null = null) {
    super(400, "VALIDATION_ERROR", message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details: unknown = null) {
    super(409, "CONFLICT", message, details)
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body exceeds the maximum allowed size", details: unknown = null) {
    super(413, "PAYLOAD_TOO_LARGE", message, details)
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter: number) {
    super(
      429,
      "RATE_LIMITED",
      "Too many requests. Please retry after the indicated number of seconds.",
      { retryAfter },
    )
  }
}

export class ServiceMisconfiguredError extends AppError {
  constructor(message = "Service misconfiguration: missing required environment variables") {
    super(503, "SERVICE_MISCONFIGURED", message)
  }
}

/**
 * A Soroban contract returned a numbered error (`Error(Contract, #N)`).
 * `contractCode` is the numeric variant documented in docs/error-codes.md.
 */
export class ContractError extends AppError {
  readonly contractCode: number

  constructor(contractCode: number, message: string, status = 422) {
    super(status, "CONTRACT_ERROR", message, { contractCode })
    this.contractCode = contractCode
  }
}

const CONTRACT_ERROR_PATTERN = /Error\(Contract, #(\d+)\)/

/** Extracts the contract error code from a Soroban host error message, if any. */
export function parseContractErrorCode(message: string): number | null {
  const match = CONTRACT_ERROR_PATTERN.exec(message)
  return match ? Number(match[1]) : null
}

/**
 * Wraps an async route handler so rejected promises reach the central error
 * handler (Express 4 does not forward them on its own).
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next)
  }
}
