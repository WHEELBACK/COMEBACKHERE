import { describe, it, expect, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { parseCorsOrigins } from "../lib/env.js"

const ALLOWED = "http://localhost:5173"
const ALSO_ALLOWED = "https://app.example.com"
const BLOCKED = "https://evil.example.com"

describe("CORS allowlist", () => {
  const app = createApp({ corsOrigins: [ALLOWED, ALSO_ALLOWED] })

  it("allows requests from an allowlisted origin", async () => {
    const res = await request(app).get("/health").set("Origin", ALLOWED)

    expect(res.status).toBe(200)
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED)
    expect(res.headers["vary"]).toMatch(/Origin/)
    expect(res.headers["access-control-expose-headers"]).toContain("X-Request-Id")
  })

  it("echoes the specific origin, never a wildcard", async () => {
    const res = await request(app).get("/health").set("Origin", ALSO_ALLOWED)
    expect(res.headers["access-control-allow-origin"]).toBe(ALSO_ALLOWED)
  })

  it("rejects requests from an unknown origin with 403 in the standard envelope", async () => {
    const res = await request(app).get("/health").set("Origin", BLOCKED).set("X-Request-Id", "req-cors")

    expect(res.status).toBe(403)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.body).toEqual({
      error: {
        code: "CORS_ORIGIN_NOT_ALLOWED",
        message: `Origin ${BLOCKED} is not allowed to access this API`,
        details: { origin: BLOCKED },
        correlationId: "req-cors",
      },
    })
  })

  it("does not treat a different port or scheme as the same origin", async () => {
    for (const origin of ["http://localhost:3001", "https://localhost:5173"]) {
      const res = await request(app).get("/health").set("Origin", origin)
      expect(res.status, origin).toBe(403)
    }
  })

  it("lets requests without an Origin header through (same-origin / server-to-server)", async () => {
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("answers preflight for the headers the frontend uses", async () => {
    const res = await request(app)
      .options("/invoices")
      .set("Origin", ALLOWED)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,idempotency-key,content-type")

    expect(res.status).toBe(204)
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED)
    expect(res.headers["access-control-allow-methods"]).toContain("POST")
    const allowedHeaders = res.headers["access-control-allow-headers"].toLowerCase()
    for (const header of ["authorization", "idempotency-key", "content-type", "x-request-id"]) {
      expect(allowedHeaders).toContain(header)
    }
  })

  it("rejects preflight from an unknown origin", async () => {
    const res = await request(app)
      .options("/invoices")
      .set("Origin", BLOCKED)
      .set("Access-Control-Request-Method", "POST")

    expect(res.status).toBe(403)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.body.error.code).toBe("CORS_ORIGIN_NOT_ALLOWED")
  })

  it("blocks every cross-origin request when the allowlist is empty", async () => {
    const closed = createApp({ corsOrigins: [] })
    const res = await request(closed).get("/health").set("Origin", ALLOWED)
    expect(res.status).toBe(403)
  })
})

describe("CORS_ORIGINS env var", () => {
  const backup = process.env.CORS_ORIGINS
  afterEach(() => {
    if (backup === undefined) delete process.env.CORS_ORIGINS
    else process.env.CORS_ORIGINS = backup
  })

  it("is read by createApp when no explicit origins are passed", async () => {
    process.env.CORS_ORIGINS = `${ALLOWED}, ${ALSO_ALLOWED}`
    const app = createApp()

    const ok = await request(app).get("/health").set("Origin", ALSO_ALLOWED)
    expect(ok.headers["access-control-allow-origin"]).toBe(ALSO_ALLOWED)

    const blocked = await request(app).get("/health").set("Origin", BLOCKED)
    expect(blocked.status).toBe(403)
  })

  it("makes createApp fail fast on an invalid value", () => {
    process.env.CORS_ORIGINS = "*"
    expect(() => createApp()).toThrow(/CORS_ORIGINS/)
  })
})

describe("parseCorsOrigins", () => {
  it("parses a comma-separated list, trimming whitespace and blanks", () => {
    expect(parseCorsOrigins(" http://localhost:5173 ,, https://app.example.com ")).toEqual([
      "http://localhost:5173",
      "https://app.example.com",
    ])
  })

  it("normalises case and default ports and de-duplicates", () => {
    expect(parseCorsOrigins("https://App.Example.com,https://app.example.com:443")).toEqual([
      "https://app.example.com",
    ])
  })

  it("returns an empty list when unset or empty", () => {
    expect(parseCorsOrigins(undefined)).toEqual([])
    expect(parseCorsOrigins("")).toEqual([])
  })

  it.each([
    ["*"],
    ["https://*.example.com"],
    ["app.example.com"],
    ["ftp://example.com"],
    ["https://app.example.com/"],
    ["https://app.example.com/path"],
    ["https://app.example.com?x=1"],
  ])("rejects %s", (value) => {
    expect(() => parseCorsOrigins(value)).toThrow(/Invalid CORS_ORIGINS/)
  })

  it("lists every invalid entry in one error", () => {
    expect(() => parseCorsOrigins("*,https://ok.example.com,nope")).toThrow(/"\*".*"nope"/)
  })
})
