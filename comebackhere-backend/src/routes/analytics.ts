import { Router, type Request, type Response } from "express"
import { connectMongo, getInvoicesCollection } from "../db/mongo.js"
import { validateQuery } from "../middleware/validate.js"
import { asyncHandler } from "../lib/errors.js"
import { analyticsQuerySchema } from "../schemas/index.js"

const router = Router()

/** Max documents pulled into memory per aggregation cursor batch. */
export const AGGREGATION_BATCH_SIZE = 500
/** Upper bound on cached series results; oldest entries are evicted first. */
export const SERIES_CACHE_MAX_ENTRIES = 100
/** How long a cached series result stays fresh. */
export const SERIES_CACHE_TTL_MS = 30_000
/** Max rows processed per aggregation stage before the query is aborted. */
export const MAX_AGGREGATION_ROWS = 100_000
/** Max time (ms) the aggregation is allowed to run server-side. */
export const AGGREGATION_MAX_TIME_MS = 10_000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Small bounded LRU-ish cache: entries are evicted when the TTL elapses or
 * when the map grows past `maxEntries` (oldest insertion evicted first).
 */
export class BoundedCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly maxEntries: number = SERIES_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = SERIES_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (maxEntries <= 0) throw new Error("maxEntries must be positive")
    if (ttlMs <= 0) throw new Error("ttlMs must be positive")
  }

  get size(): number {
    return this.store.size
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    // Refresh recency by re-inserting at the end.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.store.delete(key)
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next()
      if (oldest.done) break
      this.store.delete(oldest.value)
    }
  }

  clear(): void {
    this.store.clear()
  }
}

const seriesCache = new BoundedCache<SeriesPoint[]>()

/** Simple latency recorder used to instrument analytics queries. */
export interface LatencyRecorder {
  record(name: string, durationMs: number): void
}

const latencySamples = new Map<string, { count: number; totalMs: number; maxMs: number }>()

export const defaultLatencyRecorder: LatencyRecorder = {
  record(name, durationMs) {
    const prev = latencySamples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
    latencySamples.set(name, {
      count: prev.count + 1,
      totalMs: prev.totalMs + durationMs,
      maxMs: Math.max(prev.maxMs, durationMs),
    })
  },
}

/** Snapshot of recorded latency metrics (for tests / diagnostics). */
export function getLatencyMetrics(): Record<string, { count: number; avgMs: number; maxMs: number }> {
  const out: Record<string, { count: number; avgMs: number; maxMs: number }> = {}
  for (const [name, s] of latencySamples) {
    out[name] = { count: s.count, avgMs: s.count ? s.totalMs / s.count : 0, maxMs: s.maxMs }
  }
  return out
}

export function resetLatencyMetrics(): void {
  latencySamples.clear()
}

async function withLatency<T>(
  name: string,
  recorder: LatencyRecorder,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    recorder.record(name, Date.now() - start)
  }
}

interface InvoiceMetrics {
  pending: number
  paid: number
  cancelled: number
  expired: number
  refund_requested: number
}

interface AnalyticsData {
  invoices: InvoiceMetrics
  settled_volume: Array<{
    token: string
    volume: number
  }>
  open_disputes: number
  compliance_blocks: number
  settlement_throughput: number
}

export type Bucket = "day" | "week" | "month"

export interface SeriesPoint {
  /** Start of the bucket as a UTC date, YYYY-MM-DD. */
  period: string
  /** Invoices created in the bucket. */
  count: number
  /** Sum of raw amounts of those invoices that are settled (Paid or Released). */
  volume: number
}

/** All bucketing is done in UTC; weeks start on Monday (ISO 8601). */
export const BUCKET_TIMEZONE = "UTC"
const MAX_BUCKETS = 1000
const SETTLED_STATUSES = ["Paid", "Released"]
const DAY_MS = 86_400_000

/** Raised when the invoice aggregation fails; mapped to a 503 by the route. */
export class AnalyticsAggregationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AnalyticsAggregationError"
  }
}

/** Range used when start_date is omitted: 30 days, 12 weeks or 12 months. */
const DEFAULT_RANGE_MS: Record<Bucket, number> = {
  day: 30 * DAY_MS,
  week: 12 * 7 * DAY_MS,
  month: 365 * DAY_MS,
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

/** Start of the UTC bucket containing `date`. */
export function truncateUtc(date: Date, bucket: Bucket): Date {
  if (!isValidDate(date)) {
    throw new RangeError("truncateUtc received an invalid date")
  }
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  if (bucket === "month") return new Date(Date.UTC(y, m, 1))
  if (bucket === "week") {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7
    return new Date(Date.UTC(y, m, d - daysSinceMonday))
  }
  return new Date(Date.UTC(y, m, d))
}

function nextBucket(date: Date, bucket: Bucket): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  if (bucket === "month") return new Date(Date.UTC(y, m + 1, 1))
  return new Date(Date.UTC(y, m, d + (bucket === "week" ? 7 : 1)))
}

function periodKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Every bucket start from `start` to `end` inclusive. */
export function listPeriods(start: Date, end: Date, bucket: Bucket): string[] {
  if (!isValidDate(start) || !isValidDate(end)) {
    throw new RangeError("listPeriods received an invalid date range")
  }
  const periods: string[] = []
  if (start > end) return periods
  for (let cur = truncateUtc(start, bucket); cur <= end; cur = nextBucket(cur, bucket)) {
    periods.push(periodKey(cur))
    if (periods.length >= MAX_BUCKETS) break
  }
  return periods
}

/**
 * Invoice count and settled volume per UTC bucket, computed with a Mongo
 * aggregation. Buckets with no invoices are returned with zeros.
 */
export async function buildSeries(options: {
  bucket: Bucket
  start: Date
  end: Date
  merchant?: string
  token?: string
  /** Optional cache override (defaults to the module-level bounded cache). */
  cache?: BoundedCache<SeriesPoint[]>
  /** Optional latency recorder override. */
  latency?: LatencyRecorder
}): Promise<SeriesPoint[]> {
  const { bucket, start, end, merchant, token } = options
  const cache = options.cache ?? seriesCache
  const latency = options.latency ?? defaultLatencyRecorder

  const cacheKey = [
    bucket,
    start.getTime(),
    end.getTime(),
    merchant ?? "",
    token ?? "",
  ].join("|")

  const cached = cache.get(cacheKey)
  if (cached) return cached

  if (!isValidDate(start) || !isValidDate(end)) {
    throw new RangeError("buildSeries received an invalid date range")
  }
  if (start > end) {
    throw new RangeError("buildSeries start must be before end")
  }

  const match: Record<string, unknown> = { created_at: { $gte: start, $lte: end } }
  if (merchant) match.merchant_address = merchant
  if (token) match.token = token

  const rows = await withLatency("analytics.buildSeries.aggregate", latency, async () => {
    const db = await connectMongo()
    const cursor = getInvoicesCollection(db).aggregate<{
      _id: Date
      count: number
      volume: number
    }>(
      [
        { $match: match },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: "$created_at",
                unit: bucket,
                timezone: BUCKET_TIMEZONE,
                ...(bucket === "week" ? { startOfWeek: "monday" } : {}),
              },
            },
            count: { $sum: 1 },
            volume: {
              $sum: { $cond: [{ $in: ["$status", SETTLED_STATUSES] }, "$amount", 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: MAX_AGGREGATION_ROWS },
      ],
      { batchSize: AGGREGATION_BATCH_SIZE, maxTimeMS: AGGREGATION_MAX_TIME_MS },
    )

    // Stream results instead of materializing the whole result set at once.
    const collected: Array<{ _id: Date; count: number; volume: number }> = []
    for await (const row of cursor) {
      collected.push(row)
      if (collected.length > MAX_AGGREGATION_ROWS) break
    }
    return collected
  })

  const byPeriod = new Map(rows.map((r) => [periodKey(new Date(r._id)), r]))
  const series = listPeriods(start, end, bucket).map((period) => ({
    period,
    count: byPeriod.get(period)?.count ?? 0,
    volume: byPeriod.get(period)?.volume ?? 0,
  }))

  cache.set(cacheKey, series)
  return series
}

/**
 * @openapi
 * /api/analytics/metrics:
 *   get:
 *     tags: [Analytics]
 *     summary: Get protocol analytics metrics
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema: { type: integer }
 *       - in: query
 *         name: end_date
 *         schema: { type: integer }
 *       - in: query
 *         name: bucket
 *         schema: { type: string, enum: [day, week, month] }
 *       - in: query
 *         name: merchant
 *         schema: { type: string }
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Aggregated protocol metrics or a bucketed invoice series
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/AnalyticsMetrics'
 *                 - $ref: '#/components/schemas/AnalyticsSeries'
 *       400:
 *         description: Invalid analytics query
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * Returns aggregated protocol metrics for the admin dashboard
 *
 * Query parameters:
 * - start_date: Unix timestamp (seconds) for start of range
 * - end_date: Unix timestamp (seconds) for end of range
 * - bucket: day | week | month — when set, returns a time series instead of
 *   totals: { bucket, timezone, start_date, end_date, series: [{ period, count, volume }] }.
 *   Buckets are computed in UTC (weeks start on Monday) and every bucket in
 *   the range is present, with zeros when there was no activity. `period` is
 *   the bucket's first day (YYYY-MM-DD). Without start_date the range covers
 *   the last 30 days / 12 weeks / 12 months; end_date defaults to now.
 * - merchant, token: optional series filters (only used with bucket)
 *
 * Returns mock/aggregated data that would typically come from:
 * - Invoice contract state (invoice counts by status)
 * - Treasury contract events (settled volumes)
 * - Disputes contract state (open disputes)
 * - Compliance contract state (blocks)
 */
router.get("/metrics", validateQuery(analyticsQuerySchema), async (req: Request, res: Response) => {
  try {
    const query = analyticsQuerySchema.parse(req.query)

    if (query.bucket) {
      const end = query.end_date !== undefined ? new Date(query.end_date * 1000) : new Date()
      const start =
        query.start_date !== undefined
          ? new Date(query.start_date * 1000)
          : new Date(end.getTime() - DEFAULT_RANGE_MS[query.bucket])

      if (!isValidDate(start) || !isValidDate(end)) {
        res.status(400).json({ error: "start_date and end_date must be valid timestamps" })
        return
      }
      if (start > end) {
        res.status(400).json({ error: "start_date must be before end_date" })
        return
      }
      // Compute the bucket count once; listPeriods caps at MAX_BUCKETS so a
      // range that would exceed the cap is rejected before any DB work.
      const periods = listPeriods(start, end, query.bucket)
      if (periods.length >= MAX_BUCKETS) {
        res.status(400).json({
          error: `Range too large: at most ${MAX_BUCKETS} ${query.bucket} buckets per request`,
        })
        return
      }

      const series = await withLatency("analytics.metrics.series", defaultLatencyRecorder, () =>
        buildSeries({
          bucket: query.bucket,
          start,
          end,
          merchant: query.merchant,
          token: query.token,
        }),
      )
      res.json({
        bucket: query.bucket,
        timezone: BUCKET_TIMEZONE,
        start_date: Math.floor(start.getTime() / 1000),
        end_date: Math.floor(end.getTime() / 1000),
        series,
      })
      return
    }

    // In production, this would:
    // 1. Query the invoice contract for invoice counts by status
    // 2. Query treasury contract for settled volumes by token
    // 3. Query disputes contract for open dispute count
    // 4. Query compliance contract for active blocks
    // 5. Apply date filters if provided
    //
    // For now, return realistic mock data that can be seeded/tested
    const analyticsData: AnalyticsData = {
      invoices: {
        pending: 24,
        paid: 156,
        cancelled: 12,
        expired: 8,
        refund_requested: 3,
      },
      settled_volume: [
        { token: "USDC", volume: 184250.5 },
        { token: "XLM", volume: 52100.0 },
        { token: "EURC", volume: 12450.75 },
      ],
      open_disputes: 7,
      compliance_blocks: 3,
      settlement_throughput: 89, // settled invoices in period
    }

    res.json(analyticsData)
  } catch (error) {
    res.locals.logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Analytics metrics request failed",
    )
    if (error instanceof RangeError) {
      res.status(400).json({ error: error.message })
      return
    }
    res.status(500).json({ error: "Failed to fetch analytics metrics" })
  }
})

export default router
