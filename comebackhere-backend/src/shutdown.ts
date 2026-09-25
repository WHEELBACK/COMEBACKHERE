/**
 * Graceful shutdown sequence — Issue #219
 *
 * Kept separate from the entrypoint so it can be exercised in tests without
 * starting a real server. Order matters:
 *  1. Stop accepting new webhook jobs (late ones are persisted, not dropped)
 *  2. Stop accepting new HTTP connections; wait for in-flight requests
 *  3. Stop indexer poll loops (no new events → no new webhooks)
 *  4. Drain in-flight webhook deliveries up to the drain timeout and persist
 *     anything unfinished for retry after restart
 *  5. Close MongoDB (after the drain, which persists into it)
 * A hard timeout forces exit if any step hangs.
 */

import type { Server } from "http"
import type { WebhookDeliveryQueue } from "./services/webhook-delivery.js"

export interface ShutdownDeps {
  server: Pick<Server, "close">
  webhookQueue: Pick<WebhookDeliveryQueue, "stopAccepting" | "drain">
  stopIndexers: () => void
  closeMongo: () => Promise<void>
  /** Hard timeout — forces exit if clean shutdown hangs. */
  shutdownTimeoutMs: number
  /**
   * How long to wait for in-flight webhook deliveries. Must be shorter than
   * `shutdownTimeoutMs` (itself shorter than the orchestrator's kill grace
   * period, e.g. Kubernetes' 30s default) so the process exits cleanly.
   */
  webhookDrainTimeoutMs: number
  exit?: (code: number) => void
}

/**
 * Caps the webhook drain timeout below the hard shutdown timeout, leaving
 * `marginMs` for persisting unfinished jobs and closing MongoDB.
 */
export function resolveWebhookDrainTimeout(
  configuredMs: number,
  shutdownTimeoutMs: number,
  marginMs = 2_000,
): number {
  const ceiling = Math.max(0, shutdownTimeoutMs - marginMs)
  if (!Number.isFinite(configuredMs) || configuredMs < 0) return ceiling
  if (configuredMs > ceiling) {
    console.warn(
      `[shutdown] WEBHOOK_DRAIN_TIMEOUT_MS=${configuredMs} exceeds shutdown budget; using ${ceiling}ms`,
    )
    return ceiling
  }
  return configuredMs
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let shuttingDown = false

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`[shutdown] received ${signal} — starting graceful shutdown`)

    // Hard-timeout safety net: if clean shutdown takes too long, force exit.
    const hardTimeout = setTimeout(() => {
      console.error("[shutdown] hard timeout reached — forcing exit")
      exit(1)
    }, deps.shutdownTimeoutMs)
    // Allow the process to exit even if the timer is still pending.
    hardTimeout.unref()

    try {
      // 1. No new webhook jobs from here on.
      deps.webhookQueue.stopAccepting()

      // 2. Stop accepting new HTTP connections; wait for in-flight requests.
      await new Promise<void>((resolve, reject) => {
        deps.server.close((err) => (err ? reject(err) : resolve()))
      })
      console.log("[shutdown] HTTP server closed")

      // 3. Stop indexer poll loops.
      deps.stopIndexers()
      console.log("[shutdown] indexers stopped")

      // 4. Drain webhook deliveries; unfinished ones are persisted for retry.
      await deps.webhookQueue.drain(deps.webhookDrainTimeoutMs)

      // 5. Close MongoDB connection.
      await deps.closeMongo()
      console.log("[shutdown] MongoDB connection closed")

      clearTimeout(hardTimeout)
      console.log("[shutdown] clean exit")
      exit(0)
    } catch (err) {
      clearTimeout(hardTimeout)
      console.error("[shutdown] error during shutdown:", err)
      exit(1)
    }
  }
}
