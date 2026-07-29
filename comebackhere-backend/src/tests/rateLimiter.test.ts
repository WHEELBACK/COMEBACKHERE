import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { resetLimiter } from "../middleware/rateLimiter.js"

const MERCHANT_ADDRESS = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const FUTURE_DATE = Math.floor(Date.now() / 1000) + 86_400

const VALID_BODY = {
  merchant_address: MERCHANT_ADDRESS,
  token: "USDC",
  amount: 1_000_000,
  due_date: FUTURE_DATE,
}

describe("Rate limiting — POST /invoices", () => {
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {
      RATE_LIMIT_POINTS: process.env.RATE_LIMIT_POINTS,
      RATE_LIMIT_DURATION: process.env.RATE_LIMIT_DURATION,
      REDIS_URL: process.env.REDIS_URL,
    }
    process.env.RATE_LIMIT_POINTS = "2"
    process.env.RATE_LIMIT_DURATION = "60"
    delete process.env.REDIS_URL

    resetLimiter()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    resetLimiter()
  })

  it("allows requests within the limit", async () => {
    const app = createApp()
    const res1 = await request(app).post("/invoices").send(VALID_BODY)
    expect(res1.status).not.toBe(429)

    const res2 = await request(app).post("/invoices").send(VALID_BODY)
    expect(res2.status).not.toBe(429)
  })

  it("returns 429 after exceeding the limit", async () => {
    const app = createApp()
    await request(app).post("/invoices").send(VALID_BODY)
    await request(app).post("/invoices").send(VALID_BODY)

    const res = await request(app).post("/invoices").send(VALID_BODY)
    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/too many requests/i)
    expect(res.headers["retry-after"]).toBeDefined()
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0)
  })

  it("includes retryAfter in the response body", async () => {
    const app = createApp()
    await request(app).post("/invoices").send(VALID_BODY)
    await request(app).post("/invoices").send(VALID_BODY)

    const res = await request(app).post("/invoices").send(VALID_BODY)
    expect(res.status).toBe(429)
    expect(typeof res.body.retryAfter).toBe("number")
    expect(res.body.retryAfter).toBeGreaterThan(0)
  })

  it("allows two distinct client keys to hit limits independently", async () => {
    const app = createApp()
    const headersA = { "x-forwarded-for": "1.2.3.4" }
    const headersB = { "x-forwarded-for": "5.6.7.8" }

    const resA1 = await request(app).post("/invoices").set(headersA).send(VALID_BODY)
    expect(resA1.status).not.toBe(429)

    const resB1 = await request(app).post("/invoices").set(headersB).send(VALID_BODY)
    expect(resB1.status).not.toBe(429)

    const resA2 = await request(app).post("/invoices").set(headersA).send(VALID_BODY)
    expect(resA2.status).toBe(429)

    const resB2 = await request(app).post("/invoices").set(headersB).send(VALID_BODY)
    expect(resB2.status).not.toBe(429)
  })

  it("returns 429 for burst traffic from the same key", async () => {
    const app = createApp()
    const promises = Array.from({ length: 10 }, () => request(app).post("/invoices").send(VALID_BODY))
    const results = await Promise.all(promises)

    const statuses = results.map((r) => r.status)
    const rateLimitedCount = statuses.filter((s) => s === 429).length
    expect(rateLimitedCount).toBeGreaterThan(0)
  })
})

describe("Rate limiting — GET /invoices/:id", () => {
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {
      RATE_LIMIT_POINTS: process.env.RATE_LIMIT_POINTS,
      RATE_LIMIT_DURATION: process.env.RATE_LIMIT_DURATION,
      REDIS_URL: process.env.REDIS_URL,
    }
    process.env.RATE_LIMIT_POINTS = "2"
    process.env.RATE_LIMIT_DURATION = "60"
    delete process.env.REDIS_URL
    resetLimiter()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    resetLimiter()
  })

  it("returns 429 after exceeding the limit on GET", async () => {
    const app = createApp()
    await request(app).get("/invoices/1")
    await request(app).get("/invoices/1")

    const res = await request(app).get("/invoices/1")
    expect(res.status).toBe(429)
    expect(res.headers["retry-after"]).toBeDefined()
  })

  it("allows requests again after window reset", async () => {
    const app = createApp()
    process.env.RATE_LIMIT_DURATION = "1"

    await request(app).get("/invoices/1")
    await request(app).get("/invoices/1")
    const exhausted = await request(app).get("/invoices/1")
    expect(exhausted.status).toBe(429)

    await new Promise((r) => setTimeout(r, 1200))

    const recovered = await request(app).get("/invoices/1")
    expect(recovered.status).not.toBe(429)
  })
})
