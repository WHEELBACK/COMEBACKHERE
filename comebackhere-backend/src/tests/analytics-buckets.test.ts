import { describe, it, expect, vi, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import * as mongoModule from "../db/mongo.js"
import { listPeriods, truncateUtc } from "../routes/analytics.js"

const MERCHANT = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000)

/** Mocks the invoices collection; `rows` are what the aggregation returns. */
function mockAggregate(rows: Array<{ _id: Date; count: number; volume: number }>) {
  const aggregate = vi.fn(() => ({ toArray: async () => rows }))
  vi.spyOn(mongoModule, "connectMongo").mockResolvedValue({} as any)
  vi.spyOn(mongoModule, "getInvoicesCollection").mockReturnValue({ aggregate } as any)
  return aggregate
}

function groupStage(aggregate: ReturnType<typeof mockAggregate>) {
  const pipeline = (aggregate.mock.calls[0] as any[])[0] as any[]
  return {
    match: pipeline.find((s) => s.$match)?.$match,
    dateTrunc: pipeline.find((s) => s.$group)?.$group._id.$dateTrunc,
  }
}

describe("GET /api/analytics/metrics?bucket=", () => {
  const app = createApp()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("groups by day in UTC and fills empty days with zeros", async () => {
    const aggregate = mockAggregate([
      { _id: new Date("2026-01-01T00:00:00Z"), count: 3, volume: 2_000_000 },
      { _id: new Date("2026-01-03T00:00:00Z"), count: 1, volume: 0 },
    ])

    const res = await request(app).get(
      `/api/analytics/metrics?bucket=day&start_date=${ts("2026-01-01T00:00:00Z")}&end_date=${ts("2026-01-04T12:00:00Z")}`,
    )

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ bucket: "day", timezone: "UTC" })
    expect(res.body.series).toEqual([
      { period: "2026-01-01", count: 3, volume: 2_000_000 },
      { period: "2026-01-02", count: 0, volume: 0 },
      { period: "2026-01-03", count: 1, volume: 0 },
      { period: "2026-01-04", count: 0, volume: 0 },
    ])
    expect(groupStage(aggregate).dateTrunc).toMatchObject({ unit: "day", timezone: "UTC" })
  })

  it("groups by ISO week starting on Monday", async () => {
    const aggregate = mockAggregate([
      { _id: new Date("2026-01-05T00:00:00Z"), count: 7, volume: 500 },
    ])

    // 2026-01-01 is a Thursday, so the first bucket starts Monday 2025-12-29.
    const res = await request(app).get(
      `/api/analytics/metrics?bucket=week&start_date=${ts("2026-01-01T00:00:00Z")}&end_date=${ts("2026-01-20T00:00:00Z")}`,
    )

    expect(res.status).toBe(200)
    expect(res.body.series).toEqual([
      { period: "2025-12-29", count: 0, volume: 0 },
      { period: "2026-01-05", count: 7, volume: 500 },
      { period: "2026-01-12", count: 0, volume: 0 },
      { period: "2026-01-19", count: 0, volume: 0 },
    ])
    expect(groupStage(aggregate).dateTrunc).toMatchObject({
      unit: "week",
      timezone: "UTC",
      startOfWeek: "monday",
    })
  })

  it("groups by calendar month", async () => {
    const aggregate = mockAggregate([
      { _id: new Date("2026-02-01T00:00:00Z"), count: 2, volume: 42 },
    ])

    const res = await request(app).get(
      `/api/analytics/metrics?bucket=month&start_date=${ts("2026-01-15T00:00:00Z")}&end_date=${ts("2026-03-02T00:00:00Z")}`,
    )

    expect(res.status).toBe(200)
    expect(res.body.series).toEqual([
      { period: "2026-01-01", count: 0, volume: 0 },
      { period: "2026-02-01", count: 2, volume: 42 },
      { period: "2026-03-01", count: 0, volume: 0 },
    ])
    expect(groupStage(aggregate).dateTrunc).toMatchObject({ unit: "month", timezone: "UTC" })
    expect(groupStage(aggregate).dateTrunc.startOfWeek).toBeUndefined()
  })

  it("returns all-zero buckets for a range with no invoices", async () => {
    mockAggregate([])

    const res = await request(app).get(
      `/api/analytics/metrics?bucket=day&start_date=${ts("2026-03-01T00:00:00Z")}&end_date=${ts("2026-03-03T00:00:00Z")}`,
    )

    expect(res.status).toBe(200)
    expect(res.body.series).toEqual([
      { period: "2026-03-01", count: 0, volume: 0 },
      { period: "2026-03-02", count: 0, volume: 0 },
      { period: "2026-03-03", count: 0, volume: 0 },
    ])
  })

  it("filters the aggregation by date range, merchant and token", async () => {
    const aggregate = mockAggregate([])
    const start = ts("2026-01-01T00:00:00Z")
    const end = ts("2026-01-02T00:00:00Z")

    await request(app).get(
      `/api/analytics/metrics?bucket=day&start_date=${start}&end_date=${end}&merchant=${MERCHANT}&token=USDC`,
    )

    expect(groupStage(aggregate).match).toEqual({
      created_at: { $gte: new Date(start * 1000), $lte: new Date(end * 1000) },
      merchant_address: MERCHANT,
      token: "USDC",
    })
  })

  it("defaults to the last 30 days when start_date is omitted", async () => {
    mockAggregate([])
    const end = ts("2026-01-31T00:00:00Z")

    const res = await request(app).get(`/api/analytics/metrics?bucket=day&end_date=${end}`)

    expect(res.status).toBe(200)
    expect(res.body.series).toHaveLength(31)
    expect(res.body.series[0].period).toBe("2026-01-01")
    expect(res.body.series.at(-1).period).toBe("2026-01-31")
  })

  it("400 for an invalid bucket", async () => {
    const res = await request(app).get("/api/analytics/metrics?bucket=hour")
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/bucket/)
  })

  it("400 when the range has too many buckets", async () => {
    const res = await request(app).get(
      `/api/analytics/metrics?bucket=day&start_date=${ts("2000-01-01T00:00:00Z")}&end_date=${ts("2026-01-01T00:00:00Z")}`,
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Range too large/)
  })

  it("still returns totals when bucket is omitted", async () => {
    const res = await request(app).get("/api/analytics/metrics")
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty("invoices")
    expect(res.body).not.toHaveProperty("series")
  })
})

describe("bucket helpers", () => {
  it("truncates to the UTC bucket start", () => {
    const date = new Date("2026-01-01T23:30:00Z") // Thursday
    expect(truncateUtc(date, "day").toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(truncateUtc(date, "week").toISOString()).toBe("2025-12-29T00:00:00.000Z")
    expect(truncateUtc(date, "month").toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })

  it("treats Sunday as the last day of the week", () => {
    expect(truncateUtc(new Date("2026-01-04T10:00:00Z"), "week").toISOString()).toBe(
      "2025-12-29T00:00:00.000Z",
    )
  })

  it("lists a single bucket for a range inside one period", () => {
    const start = new Date("2026-05-10T01:00:00Z")
    const end = new Date("2026-05-10T02:00:00Z")
    expect(listPeriods(start, end, "day")).toEqual(["2026-05-10"])
    expect(listPeriods(start, end, "month")).toEqual(["2026-05-01"])
  })
})
