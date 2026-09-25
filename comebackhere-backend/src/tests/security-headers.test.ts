import { describe, it, expect } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"

describe("security headers", () => {
  const app = createApp()

  it("sets the helmet baseline on API responses", async () => {
    const res = await request(app).get("/health")

    expect(res.status).toBe(200)
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/)
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN")
    expect(res.headers["referrer-policy"]).toBe("no-referrer")
    expect(res.headers["x-powered-by"]).toBeUndefined()
  })

  it("uses a strict Content-Security-Policy for the JSON API", async () => {
    const res = await request(app).get("/health")
    const csp = res.headers["content-security-policy"]

    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("sets security headers on error responses too", async () => {
    const res = await request(app).get("/does-not-exist")

    expect(res.status).toBe(404)
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'")
  })

  it("still lets Swagger UI load its same-origin assets", async () => {
    const page = await request(app).get("/api-docs/")
    expect(page.status).toBe(200)
    expect(page.text).toContain("swagger-ui-bundle.js")

    const csp = page.headers["content-security-policy"]
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).not.toContain("default-src 'none'")

    for (const asset of ["swagger-ui-bundle.js", "swagger-ui-init.js", "swagger-ui.css"]) {
      const res = await request(app).get(`/api-docs/${asset}`)
      expect(res.status, asset).toBe(200)
    }
  })
})

describe("JSON body size limit", () => {
  const app = createApp()

  it("returns 413 in the standard envelope for bodies over 100kb", async () => {
    const res = await request(app)
      .post("/api/treasury/threshold")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", "req-too-large")
      .send(JSON.stringify({ threshold: 1, padding: "x".repeat(101 * 1024) }))

    expect(res.status).toBe(413)
    expect(res.headers["content-type"]).toMatch(/application\/json/)
    expect(res.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the maximum allowed size",
        details: { limitBytes: 100 * 1024 },
        correlationId: "req-too-large",
      },
    })
  })

  it("accepts bodies under the limit", async () => {
    const res = await request(app)
      .post("/api/treasury/threshold")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ threshold: -1, padding: "x".repeat(50 * 1024) }))

    // Reaches validation (400) rather than being rejected for size
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})
