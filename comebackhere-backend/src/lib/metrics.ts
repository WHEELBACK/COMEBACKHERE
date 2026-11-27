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

export const webhookDeliveryAttempts = new Counter({
  name: "webhook_delivery_attempts_total",
  help: "Webhook HTTP delivery attempts",
  registers: [metricsRegistry],
})

export const webhookDeliveryRetries = new Counter({
  name: "webhook_delivery_retries_total",
  help: "Webhook delivery retries after the initial attempt",
  registers: [metricsRegistry],
})

export const webhookDeliveryDuration = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Time spent delivering a webhook event",
  labelNames: ["status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
})

export const webhookDeadLetterVolume = new Gauge({
  name: "webhook_dead_letter_volume",
  help: "Number of webhook deliveries currently in the dead-letter store",
  registers: [metricsRegistry],
})

export const reportingDbQueryDuration = new Histogram({
  name: "reporting_db_query_duration_seconds",
  help: "Duration of reporting-engine database queries in seconds",
  labelNames: ["operation", "status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
})

export const reportingDbQueryTotal = new Counter({
  name: "reporting_db_query_total",
  help: "Total reporting-engine database queries by outcome",
  labelNames: ["operation", "status"],
  registers: [metricsRegistry],
})

export const reportingDbRowsReturned = new Histogram({
  name: "reporting_db_rows_returned",
  help: "Number of rows returned per reporting-engine database query",
  labelNames: ["operation"],
  buckets: [0, 1, 10, 100, 500, 1000, 5000, 10000, 50000],
  registers: [metricsRegistry],
})

export const reportingCacheOperations = new Counter({
  name: "reporting_cache_operations_total",
  help: "Reporting-engine cache operations by result",
  labelNames: ["operation", "result"],
  registers: [metricsRegistry],
})

export const reportingCacheOperationDuration = new Histogram({
  name: "reporting_cache_operation_duration_seconds",
  help: "Duration of reporting-engine cache operations in seconds",
  labelNames: ["operation"],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
})

export const reportingCacheEntries = new Gauge({
  name: "reporting_cache_entries",
  help: "Number of entries currently held in the reporting-engine cache",
  registers: [metricsRegistry],
})

export const reportingCacheEvictions = new Counter({
  name: "reporting_cache_evictions_total",
  help: "Number of reporting-engine cache entries evicted",
  labelNames: ["reason"],
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

export const authRequestOutcomes = new Counter({
  name: "auth_request_outcomes_total",
  help: "Auth request outcomes by operation and result",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
})

export const authValidationFailures = new Counter({
  name: "auth_validation_failures_total",
  help: "Auth request validation failures by operation and reason",
  labelNames: ["operation", "reason"],
  registers: [metricsRegistry],
})

export const authDbQueryDuration = new Histogram({
  name: "auth_db_query_duration_seconds",
  help: "Auth-service database query latency in seconds",
  labelNames: ["operation", "status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
})

export const authCacheEvictions = new Counter({
  name: "auth_cache_evictions_total",
  help: "Auth-service cache evictions by cache and reason",
  labelNames: ["cache", "reason"],
  registers: [metricsRegistry],
})

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
