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
import { closeMongo } from "./db/mongo.js"
import { webhookDeliveryQueue } from "./services/webhook-delivery.js"
import { createShutdownHandler, resolveWebhookDrainTimeout } from "./shutdown.js"
import { validateEnv } from "./lib/env.js"
import type { Server } from "http"

// Fail fast on missing variables or malformed Stellar ids, naming the variable.
try {
  validateEnv(process.env)
} catch (err) {
  console.error(`[startup] ${err instanceof Error ? err.message : err}`)
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

// Retry deliveries that a previous process persisted during shutdown.
webhookDeliveryQueue.resumePending().catch((err: unknown) => {
  console.error(
    "[webhook] could not resume persisted deliveries:",
    err instanceof Error ? err.message : err,
  )
})

const server: Server = app.listen(Number(PORT), () => {
  console.log(`comebackhere-backend listening on port ${PORT}`)
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
    console.log("[shutdown] indexers stopped")

    // 3. Close MongoDB connection.
    await closeMongo()
    console.log("[shutdown] MongoDB connection closed")

    clearTimeout(hardTimeout)
    console.log("[shutdown] clean exit")
    process.exit(0)
  } catch (err) {
    console.error("[shutdown] error during shutdown:", err)
    process.exit(1)
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT",  () => void shutdown("SIGINT"))
