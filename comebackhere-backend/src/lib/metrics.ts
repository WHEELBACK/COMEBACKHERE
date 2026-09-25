/**
 * Minimal in-process metrics registry rendered in the Prometheus text
 * exposition format at GET /metrics. Only counters and gauges are needed
 * today; swap for prom-client if histograms become necessary.
 */

type Labels = Record<string, string>

interface Metric {
  name: string
  help: string
  type: "counter" | "gauge"
  values: Map<string, { labels: Labels; value: number }>
}

const registry = new Map<string, Metric>()

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",")
}

function register(name: string, help: string, type: Metric["type"]): Metric {
  let metric = registry.get(name)
  if (!metric) {
    metric = { name, help, type, values: new Map() }
    registry.set(name, metric)
  }
  return metric
}

function makeMetric(name: string, help: string, type: Metric["type"]) {
  const metric = register(name, help, type)
  return {
    get(labels: Labels = {}): number {
      return metric.values.get(labelKey(labels))?.value ?? 0
    },
    set(value: number, labels: Labels = {}): void {
      metric.values.set(labelKey(labels), { labels, value })
    },
    inc(labels: Labels = {}, by = 1): void {
      const key = labelKey(labels)
      const current = metric.values.get(key)?.value ?? 0
      metric.values.set(key, { labels, value: current + by })
    },
  }
}

export function counter(name: string, help: string) {
  const { get, inc } = makeMetric(name, help, "counter")
  return { get, inc }
}

export function gauge(name: string, help: string) {
  return makeMetric(name, help, "gauge")
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

export function renderMetrics(): string {
  const lines: string[] = []
  for (const metric of registry.values()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`)
    lines.push(`# TYPE ${metric.name} ${metric.type}`)
    for (const { labels, value } of metric.values.values()) {
      const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      lines.push(`${metric.name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${value}`)
    }
  }
  return lines.join("\n") + "\n"
}

/** Exported for tests. */
export function _resetMetrics(): void {
  for (const metric of registry.values()) metric.values.clear()
}
