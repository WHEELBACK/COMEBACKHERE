import cors from "cors"
import type { RequestHandler } from "express"
import { AppError } from "../lib/errors.js"

/** Request headers the frontend sends and preflight must allow. */
export const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "Idempotency-Key",
  "X-Request-Id",
  "X-Admin-Key",
]

/** Response headers browsers may read from cross-origin responses. */
export const CORS_EXPOSED_HEADERS = [
  "X-Request-Id",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "Retry-After",
]

export class CorsOriginError extends AppError {
  constructor(origin: string) {
    super(403, "CORS_ORIGIN_NOT_ALLOWED", `Origin ${origin} is not allowed to access this API`, { origin })
  }
}

/**
 * CORS middleware backed by an explicit origin allowlist (see
 * `parseCorsOrigins` in lib/env.ts).
 *
 * - Requests without an `Origin` header (same-origin, curl, server-to-server)
 *   pass through untouched.
 * - Allowlisted origins get the usual `Access-Control-*` headers, and
 *   preflight requests are answered with 204.
 * - Any other origin — including preflight — is rejected with 403 in the
 *   standard error envelope.
 */
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins)

  return cors({
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) {
        callback(null, true)
        return
      }
      callback(new CorsOriginError(origin))
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 600,
    optionsSuccessStatus: 204,
  })
}
