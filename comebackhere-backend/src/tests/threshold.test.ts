import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"

const ENV = {
  SOROBAN_RPC_URL: "http://localhost:8000",
  SIGNER_SECRET_KEY: "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ",
  NETWORK_PASSPHRASE: "Standalone Network ; February 2025",
}

describe("POST /api/treasury/threshold", () => {
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {}
    for (const key of Object.keys(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = ENV[key as keyof typeof ENV]
    }
    vi.resetModules()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it("returns 400 when threshold is missing", async () => {
    const app = createApp()
    const res = await request(app).post("/api/treasury/threshold").send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("Validation failed")
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "threshold",
        }),
      ])
    )
  })

  it("returns 400 when threshold is not a positive integer", async () => {
    const app = createApp()
    const res = await request(app).post("/api/treasury/threshold").send({ threshold: -1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("Validation failed")
  })

  it("creates a threshold update and returns the new value", async () => {
    const app = createApp()
    const res = await request(app)
      .post("/api/treasury/threshold")
      .send({ threshold: 3, caller: "GADDRESS" })

    expect(res.status).toBe(200)
    expect(res.body.threshold).toBe(3)
    expect(res.body.previous_threshold).toBe(0)
    expect(res.body.tx_hash).toBeDefined()
  })

  it("creates a corresponding audit record when threshold is updated", async () => {
    const app = createApp()
    await request(app)
      .post("/api/treasury/threshold")
      .send({ threshold: 5, caller: "GADDRESS" })

    const auditRes = await request(app).get("/api/treasury/threshold/audit")
    expect(auditRes.status).toBe(200)
    expect(Array.isArray(auditRes.body)).toBe(true)
    const latest = auditRes.body[0]
    expect(latest.action).toBe("threshold_update")
    expect(latest.resource).toBe("treasury")
    expect(latest.new_value).toBe(5)
    expect(latest.previous_value).toBe(0)
    expect(latest.caller).toBe("GADDRESS")
    expect(latest.tx_hash).toBeDefined()
  })
})
