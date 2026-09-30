import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client"

type Labels = Record<string, string>

export const metricsRegistry = new Registry()
collectDefaultMetrics({ register: metricsRegistry })

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
})

export const indexerLedgerLag = new Gauge({
  name: "indexer_ledger_lag",
  help: "Number of ledgers the indexer is behind the latest Soroban ledger",
  labelNames: ["indexer"],
  registers: [metricsRegistry],
})

export const webhookDeliveryOutcomes = new Counter({
  name: "webhook_delivery_total",
  help: "Webhook delivery outcomes",
  labelNames: ["status"],
  registers: [metricsRegistry],
})

const retentionLabels = ["indexer"] as const

export function counter(name: string, help: string) {
  const metric = new Counter({
    name,
    help,
    labelNames: name.startsWith("indexer_retention_") ? [...retentionLabels] : [],
    registers: [metricsRegistry],
  })
  return {
    inc(labels: Labels = {}, by = 1): void {
      metric.inc(labels, by)
    },
  }
}

export function gauge(name: string, help: string) {
  const metric = new Gauge({
    name,
    help,
    labelNames: name.startsWith("indexer_retention_") ? [...retentionLabels] : [],
    registers: [metricsRegistry],
  })
  return {
    set(value: number, labels: Labels = {}): void {
      metric.set(labels, value)
    },
  }
}

export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED?.toLowerCase() !== "false"
}

export function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics()
}

/** Exported for tests and process-local instrumentation resets. */
export function _resetMetrics(): void {
  metricsRegistry.resetMetrics()
}
