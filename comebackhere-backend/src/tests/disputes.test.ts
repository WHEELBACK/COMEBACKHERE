import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"

describe("POST /disputes/:id/vote", () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    app = createApp()
  })

  it("returns 400 when signer_address is missing", async () => {
    const res = await request(app).post("/disputes/dispute-1/vote").send({ weight: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("Validation failed")
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "signer_address",
        }),
      ])
    )
  })

  it("returns 400 when weight is missing", async () => {
    const res = await request(app)
      .post("/disputes/dispute-1/vote")
      .send({ signer_address: "GADDRESS" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("Validation failed")
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "weight",
        }),
      ])
    )
  })

  it("accepts a vote and returns the total weight when multiple signers vote", async () => {
    const signerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const signerB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    const resA = await request(app)
      .post("/disputes/dispute-1/vote")
      .send({ signer_address: signerA, weight: 2 })
    expect(resA.status).toBe(200)
    expect(resA.body.accepted).toBeUndefined()
    expect(resA.body.signer_address).toBe(signerA)
    expect(resA.body.weight).toBe(2)
    expect(resA.body.total_weight).toBe(2)

    const resB = await request(app)
      .post("/disputes/dispute-1/vote")
      .send({ signer_address: signerB, weight: 3 })
    expect(resB.status).toBe(200)
    expect(resB.body.total_weight).toBe(5)
  })

  it("rejects duplicate votes from the same signer", async () => {
    const signer = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"

    const first = await request(app)
      .post("/disputes/dispute-1/vote")
      .send({ signer_address: signer, weight: 1 })
    expect(first.status).toBe(200)
    expect(first.body.total_weight).toBe(1)

    const duplicate = await request(app)
      .post("/disputes/dispute-1/vote")
      .send({ signer_address: signer, weight: 1 })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error).toBe("Duplicate vote")
    expect(duplicate.body.total_weight).toBe(1)
  })
})
