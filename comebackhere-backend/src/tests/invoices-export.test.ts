import { describe, it, expect, vi, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import * as mongoModule from "../db/mongo.js"
import { escapeCsvField, formatTokenAmount, CSV_COLUMNS } from "../routes/invoices.js"

const MERCHANT = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const HEADER = CSV_COLUMNS.join(",")

function makeInvoice(i: number, overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: String(i),
    merchant_address: MERCHANT,
    token: "USDC",
    amount: 12_500_000,
    due_date: 1_767_225_600, // 2026-01-01T00:00:00Z
    status: "Pending",
    created_at: new Date("2025-12-01T10:00:00Z"),
    updated_at: new Date("2025-12-02T10:00:00Z"),
    ...overrides,
  }
}

/**
 * Mocks the invoices collection with a cursor that yields `docs` one by one.
 * `toArray` is a spy so tests can assert the export never buffers everything.
 */
function mockInvoices(docs: Iterable<Record<string, unknown>>, options: { failAt?: number } = {}) {
  const close = vi.fn().mockResolvedValue(undefined)
  const toArray = vi.fn()
  const cursor = {
    close,
    toArray,
    async *[Symbol.asyncIterator]() {
      let i = 0
      for (const doc of docs) {
        if (options.failAt === i++) throw new Error("cursor exploded")
        yield doc
      }
      if (options.failAt === i) throw new Error("cursor exploded")
    },
  }
  const sort = vi.fn(() => cursor)
  const find = vi.fn(() => ({ sort }))
  vi.spyOn(mongoModule, "connectMongo").mockResolvedValue({} as any)
  vi.spyOn(mongoModule, "getInvoicesCollection").mockReturnValue({ find } as any)
  return { find, sort, close, toArray }
}

describe("GET /invoices/export.csv", () => {
  const app = createApp()

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.TOKEN_METADATA
  })

  it("sets CSV and download headers", async () => {
    mockInvoices([makeInvoice(1)])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8")
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"$/)
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("writes a header row and one row per invoice with raw and human amounts", async () => {
    mockInvoices([makeInvoice(1), makeInvoice(2, { amount: 30_000_000, status: "Paid", reference: "order-2" })])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.text.split("\r\n")).toEqual([
      HEADER,
      `1,${MERCHANT},USDC,12500000,1.25 USDC,Pending,,2026-01-01T00:00:00.000Z,2025-12-01T10:00:00.000Z,2025-12-02T10:00:00.000Z`,
      `2,${MERCHANT},USDC,30000000,3 USDC,Paid,order-2,2026-01-01T00:00:00.000Z,2025-12-01T10:00:00.000Z,2025-12-02T10:00:00.000Z`,
      "",
    ])
  })

  it("escapes commas, quotes and newlines", async () => {
    mockInvoices([makeInvoice(1, { reference: 'Order "A", line 1\nline 2' })])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.text).toContain(`,"Order ""A"", line 1\nline 2",`)
  })

  it("neutralises spreadsheet formulas in text fields", async () => {
    mockInvoices([makeInvoice(1, { reference: "=HYPERLINK(\"http://evil\")" })])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.text).toContain(`,"'=HYPERLINK(""http://evil"")",`)
  })

  it("uses TOKEN_METADATA for symbol and decimals", async () => {
    process.env.TOKEN_METADATA = JSON.stringify({ CUSDCCONTRACT: { symbol: "USDC", decimals: 6 } })
    mockInvoices([makeInvoice(1, { token: "CUSDCCONTRACT", amount: 1_500_000 })])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.text.split("\r\n")[1]).toContain(",CUSDCCONTRACT,1500000,1.5 USDC,")
  })

  it("returns only the header for an empty result", async () => {
    mockInvoices([])

    const res = await request(app).get("/invoices/export.csv")

    expect(res.status).toBe(200)
    expect(res.text).toBe(`${HEADER}\r\n`)
  })

  describe("filters", () => {
    it("applies status and merchant like the list endpoint", async () => {
      const { find, sort } = mockInvoices([])

      const res = await request(app).get(`/invoices/export.csv?status=Paid&merchant=${MERCHANT}`)

      expect(find).toHaveBeenCalledWith({ status: "Paid", merchant_address: MERCHANT })
      expect(sort).toHaveBeenCalledWith({ created_at: -1 })
      expect(res.headers["content-disposition"]).toMatch(/filename="invoices-paid-/)
    })

    it("exports everything without filters", async () => {
      const { find } = mockInvoices([])
      await request(app).get("/invoices/export.csv")
      expect(find).toHaveBeenCalledWith({})
    })

    it("ignores unknown status values, as the list endpoint does", async () => {
      const { find } = mockInvoices([])
      await request(app).get("/invoices/export.csv?status=Bogus")
      expect(find).toHaveBeenCalledWith({})
    })
  })

  it("streams large exports from the cursor without buffering", async () => {
    function* many() {
      for (let i = 0; i < 20_000; i++) yield makeInvoice(i)
    }
    const { toArray, close } = mockInvoices(many())

    const res = await request(app).get("/invoices/export.csv")

    expect(res.status).toBe(200)
    expect(res.text.split("\r\n")).toHaveLength(20_002) // header + rows + trailing ""
    expect(toArray).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it("returns a JSON 500 when the cursor fails before any row is sent", async () => {
    const { close } = mockInvoices([makeInvoice(1)], { failAt: 0 })

    const res = await request(app).get("/invoices/export.csv")

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: "cursor exploded" })
    expect(res.headers["content-disposition"]).toBeUndefined()
    expect(close).toHaveBeenCalled()
  })

  it("aborts the response when the cursor fails mid-stream", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockInvoices([makeInvoice(1), makeInvoice(2)], { failAt: 1 })

    await expect(request(app).get("/invoices/export.csv")).rejects.toThrow()
  })

  it("is not captured by the /invoices/:id route", async () => {
    mockInvoices([])
    const res = await request(app).get("/invoices/export.csv")
    expect(res.status).toBe(200)
  })
})

describe("CSV helpers", () => {
  it("escapeCsvField", () => {
    expect(escapeCsvField("plain")).toBe("plain")
    expect(escapeCsvField("a,b")).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField("line\r\nbreak")).toBe('"line\r\nbreak"')
    expect(escapeCsvField(undefined)).toBe("")
    expect(escapeCsvField(null)).toBe("")
    expect(escapeCsvField("-1+1")).toBe("'-1+1")
    expect(escapeCsvField("@SUM(A1)")).toBe("'@SUM(A1)")
  })

  it("formatTokenAmount", () => {
    expect(formatTokenAmount(12_500_000, 7)).toBe("1.25")
    expect(formatTokenAmount(1, 7)).toBe("0.0000001")
    expect(formatTokenAmount(0, 7)).toBe("0")
    expect(formatTokenAmount(100_000_000, 7)).toBe("10")
    expect(formatTokenAmount("123456789012345678901234567890", 7)).toBe("12345678901234567890123.456789")
    expect(formatTokenAmount(5, 0)).toBe("5")
  })
})
