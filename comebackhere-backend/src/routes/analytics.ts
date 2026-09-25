import { Router, type Request, type Response } from "express"
import { connectMongo, getInvoicesCollection } from "../db/mongo.js"
import { validateQuery } from "../middleware/validate.js"
import { asyncHandler } from "../lib/errors.js"
import { analyticsQuerySchema } from "../schemas/index.js"

const router = Router()

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

/** Range used when start_date is omitted: 30 days, 12 weeks or 12 months. */
const DEFAULT_RANGE_MS: Record<Bucket, number> = {
  day: 30 * DAY_MS,
  week: 12 * 7 * DAY_MS,
  month: 365 * DAY_MS,
}

/** Start of the UTC bucket containing `date`. */
export function truncateUtc(date: Date, bucket: Bucket): Date {
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
  const periods: string[] = []
  for (let cur = truncateUtc(start, bucket); cur <= end; cur = nextBucket(cur, bucket)) {
    periods.push(periodKey(cur))
    if (periods.length > MAX_BUCKETS) break
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
}): Promise<SeriesPoint[]> {
  const { bucket, start, end, merchant, token } = options

  const match: Record<string, unknown> = { created_at: { $gte: start, $lte: end } }
  if (merchant) match.merchant_address = merchant
  if (token) match.token = token

  const db = await connectMongo()
  const rows = await getInvoicesCollection(db)
    .aggregate<{ _id: Date; count: number; volume: number }>([
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
    ])
    .toArray()

  const byPeriod = new Map(rows.map((r) => [periodKey(new Date(r._id)), r]))
  return listPeriods(start, end, bucket).map((period) => ({
    period,
    count: byPeriod.get(period)?.count ?? 0,
    volume: byPeriod.get(period)?.volume ?? 0,
  }))
}

/**
 * GET /api/analytics/metrics
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

      if (start > end) {
        res.status(400).json({ error: "start_date must be before end_date" })
        return
      }
      if (listPeriods(start, end, query.bucket).length > MAX_BUCKETS) {
        res.status(400).json({
          error: `Range too large: at most ${MAX_BUCKETS} ${query.bucket} buckets per request`,
        })
        return
      }

      const series = await buildSeries({
        bucket: query.bucket,
        start,
        end,
        merchant: query.merchant,
        token: query.token,
      })
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
    console.error("Error fetching analytics metrics:", error)
    res.status(500).json({ error: "Failed to fetch analytics metrics" })
  }

  res.json(analyticsData)
}))

export default router
