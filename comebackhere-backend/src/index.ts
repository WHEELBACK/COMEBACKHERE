/**
 * Backend entrypoint — Issue #219
 *
 * Handles SIGTERM and SIGINT for graceful shutdown (see ./shutdown.ts):
 * stops accepting HTTP connections and webhook jobs, stops the indexers,
 * drains in-flight webhook deliveries (persisting unfinished ones for retry),
 * closes MongoDB, and applies a hard-timeout safety net.
 */

import { createApp } from "./app.js"
import { startTreasuryIndexer, stopTreasuryIndexer } from "./services/treasury-indexer.js"
import { stopIndexer } from "./indexer.js"
import { stopComplianceIndexer } from "./services/compliance-indexer.js"
import { closeMongo, connectMongo, ensureIndexes } from "./db/mongo.js"
import { webhookDeliveryQueue } from "./services/webhook-delivery.js"
import { createShutdownHandler, resolveWebhookDrainTimeout } from "./shutdown.js"
import { validateEnv } from "./lib/env.js"
import { logger } from "./lib/logger.js"
import type { Server } from "http"

// Fail fast on missing variables or malformed Stellar ids, naming the variable.
try {
  validateEnv(process.env)
} catch (err) {
  logger.fatal({ errorName: err instanceof Error ? err.name : "UnknownError" }, "Environment validation failed")
  process.exit(1)
}

const PORT = process.env.PORT ?? "3000"
/** Hard shutdown timeout in ms — forces exit if clean shutdown hangs. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000")
/** Max time to wait for in-flight webhook deliveries; capped below SHUTDOWN_TIMEOUT_MS. */
const WEBHOOK_DRAIN_TIMEOUT_MS = resolveWebhookDrainTimeout(
  Number(process.env.WEBHOOK_DRAIN_TIMEOUT_MS ?? "5000"),
  SHUTDOWN_TIMEOUT_MS,
)

const app = createApp()
startTreasuryIndexer()

void connectMongo()
  .then((database) => ensureIndexes(database))
  .catch((err: unknown) => {
    logger.error({ errorName: err instanceof Error ? err.name : "UnknownError" }, "MongoDB startup/index initialization failed")
  })

// Retry deliveries that a previous process persisted during shutdown.
webhookDeliveryQueue.resumePending().catch((err: unknown) => {
  logger.error({ errorName: err instanceof Error ? err.name : "UnknownError" }, "Could not resume persisted webhook deliveries")
})

const server: Server = app.listen(Number(PORT), () => {
  logger.info({ port: Number(PORT) }, "Backend listening")
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = createShutdownHandler({
  server,
  webhookQueue: webhookDeliveryQueue,
  stopIndexers: () => {
    stopTreasuryIndexer()
    stopIndexer()
    stopComplianceIndexer()
  },
  closeMongo,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  webhookDrainTimeoutMs: WEBHOOK_DRAIN_TIMEOUT_MS,
})

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT",  () => void shutdown("SIGINT"))
