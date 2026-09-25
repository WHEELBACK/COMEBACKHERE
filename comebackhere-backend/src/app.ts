import express from "express"
import helmet from "helmet"
import swaggerUi from "swagger-ui-express"
import invoicesRouter from "./routes/invoices.js"
import complianceRouter from "./routes/compliance.js"
import releaseEscrowRouter from "./routes/release-escrow.js"
import treasuryRouter from "./routes/treasury.js"
import invoiceSettingsRouter from "./routes/invoice-settings.js"
import thresholdRouter from "./routes/threshold.js"
import disputesRouter from "./routes/disputes.js"
import analyticsRouter from "./routes/analytics.js"
import { startComplianceIndexer } from "./services/compliance-indexer.js"
import { rateLimitMiddleware } from "./middleware/rateLimiter.js"
import { idempotencyMiddleware } from "./middleware/idempotency.js"
import { correlationIdMiddleware } from "./middleware/correlationId.js"
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js"
import { createCorsMiddleware } from "./middleware/cors.js"
import { parseCorsOrigins } from "./lib/env.js"
import { openapiSpec } from "./openapi.js"
import { renderMetrics } from "./lib/metrics.js"

/** Maximum accepted JSON body size; larger requests get a 413 envelope. */
export const JSON_BODY_LIMIT = "100kb"

// This is a JSON API, so by default nothing may be loaded, framed or executed.
const apiHelmet = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
})

// Swagger UI serves its JS/CSS from same-origin files but also uses inline
// <style> blocks and data: images, and "Try it out" calls back into the API.
const swaggerHelmet = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
})

export interface CreateAppOptions {
  /** Origins allowed to call the API cross-origin. Defaults to CORS_ORIGINS. */
  corsOrigins?: readonly string[]
}

export function createApp(options: CreateAppOptions = {}) {
  const corsOrigins = options.corsOrigins ?? parseCorsOrigins()
  const app = express()
  app.disable("x-powered-by")
  // Attach / propagate X-Request-Id before any other middleware so every log
  // line, downstream call and error envelope can reference the same
  // correlation ID — including body-parsing errors.
  app.use(correlationIdMiddleware)
  app.use((req, res, next) =>
    req.path === "/api-docs" || req.path.startsWith("/api-docs/")
      ? swaggerHelmet(req, res, next)
      : apiHelmet(req, res, next),
  )
  // CORS runs before body parsing and rate limiting so preflights are cheap
  // and disallowed origins are rejected before any work is done.
  app.use(createCorsMiddleware(corsOrigins))
  app.use(express.json({ limit: JSON_BODY_LIMIT }))
  app.use(rateLimitMiddleware)
  app.use("/invoices", idempotencyMiddleware)

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => res.json({ status: "ok" }))

  // ── Prometheus metrics ──────────────────────────────────────────────────────
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(renderMetrics())
  })

  // ── OpenAPI spec (Issue #218) ───────────────────────────────────────────────
  // Raw JSON spec at a stable, machine-readable URL
  app.get("/api-docs/swagger.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.json(openapiSpec)
  })
  // Swagger UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiSpec))

  // ── Application routes ──────────────────────────────────────────────────────
  app.use("/invoices", invoicesRouter)
  app.use("/invoices", releaseEscrowRouter)
  app.use("/compliance", complianceRouter)
  app.use("/api/treasury", treasuryRouter)
  app.use("/api/invoice", invoiceSettingsRouter)
  app.use("/api/treasury", thresholdRouter)
  app.use("/disputes", disputesRouter)
  app.use("/api/analytics", analyticsRouter)

  // ── Errors ──────────────────────────────────────────────────────────────────
  // Everything below produces { error: { code, message, details, correlationId } }
  app.use(notFoundHandler)
  app.use(errorHandler)
  // Start indexing only when the application is actually created; tests omit
  // the required contract/RPC configuration and therefore remain side-effect free.
  startComplianceIndexer()
  return app
}
