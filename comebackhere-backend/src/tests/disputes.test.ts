import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { Keypair } from "stellar-sdk"
import { createApp } from "../app.js"
import { _resetDisputeStore } from "../routes/disputes.js"
import { resetLimiter } from "../middleware/rateLimiter.js"

const ADMIN_KEY = "test-admin-key"
const ENV = {
  SOROBAN_RPC_URL: "http://localhost:8000/soroban/rpc",
  SETTLEMENT_CONTRACT_ID: "CSETTLEMENT",
  SIGNER_SECRET_KEY: Keypair.random().secret(),
  ADMIN_KEY,
  // Many requests per test; keep the shared in-memory limiter out of the way
  RATE_LIMIT_POINTS: "10000",
}

const CLAIMANT = Keypair.random().publicKey()
const SIGNER_A = Keypair.random().publicKey()
const SIGNER_B = Keypair.random().publicKey()
const SIGNER_C = Keypair.random().publicKey()

describe("dispute read endpoints", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    _resetDisputeStore()
    envBackup = {}
    for (const [key, value] of Object.entries(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = value
    }
    resetLimiter()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetLimiter()
  })

  async function createDispute(settlementId: string, reason?: string): Promise<string> {
    const res = await request(app)
      .post("/disputes")
      .send({ claimant_address: CLAIMANT, settlement_id: settlementId, reason })
    expect(res.status).toBe(201)
    return res.body.dispute_id
  }

  async function vote(id: string, signer: string, v: "ResolvedClaimant" | "ResolvedCounterparty", weight = 1) {
    return request(app).post(`/disputes/${id}/vote`).send({ signer_address: signer, vote: v, weight })
  }

  describe("GET /disputes/:id", () => {
    it("returns full details and tallies for a new dispute", async () => {
      const id = await createDispute("5", "Goods not delivered")
      const res = await request(app).get(`/disputes/${id}`)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        dispute_id: id,
        settlement_id: "5",
        claimant_address: CLAIMANT,
        reason: "Goods not delivered",
        status: "Raised",
        outcome: null,
        claimant_weight: 0,
        counterparty_weight: 0,
        resolution_weight: 0,
        threshold: 2,
        vote_count: 0,
        resolved_at: null,
      })
      expect(new Date(res.body.created_at).toString()).not.toBe("Invalid Date")
    })

    it("reflects votes in the tallies", async () => {
      const id = await createDispute("5")
      await vote(id, SIGNER_A, "ResolvedClaimant")
      await vote(id, SIGNER_B, "ResolvedCounterparty")

      const res = await request(app).get(`/disputes/${id}`)
      expect(res.body).toMatchObject({
        status: "Raised",
        claimant_weight: 1,
        counterparty_weight: 1,
        resolution_weight: 2,
        vote_count: 2,
        outcome: null,
      })
    })

    it("marks the dispute Resolved once a side reaches the threshold", async () => {
      const id = await createDispute("5")
      await vote(id, SIGNER_A, "ResolvedClaimant")
      await vote(id, SIGNER_B, "ResolvedClaimant")

      const res = await request(app).get(`/disputes/${id}`)
      expect(res.body.status).toBe("Resolved")
      expect(res.body.outcome).toBe("ResolvedClaimant")
      expect(res.body.resolved_at).not.toBeNull()
    })

    it("hides voter identities from non-admins", async () => {
      const id = await createDispute("5")
      await vote(id, SIGNER_A, "ResolvedClaimant")

      const res = await request(app).get(`/disputes/${id}`)
      expect(res.body).not.toHaveProperty("votes")
      expect(JSON.stringify(res.body)).not.toContain(SIGNER_A)
    })

    it("shows voter identities to admins", async () => {
      const id = await createDispute("5")
      await vote(id, SIGNER_A, "ResolvedClaimant", 1)
      await vote(id, SIGNER_B, "ResolvedCounterparty", 1)

      const res = await request(app).get(`/disputes/${id}`).set("x-admin-key", ADMIN_KEY)
      expect(res.status).toBe(200)
      expect(res.body.votes).toHaveLength(2)
      expect(res.body.votes[0]).toMatchObject({ signer: SIGNER_A, vote: "ResolvedClaimant", weight: 1 })
      expect(res.body.votes[1]).toMatchObject({ signer: SIGNER_B, vote: "ResolvedCounterparty", weight: 1 })
    })

    it("rejects an invalid admin key with 401", async () => {
      const id = await createDispute("5")
      const res = await request(app).get(`/disputes/${id}`).set("x-admin-key", "wrong")
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe("UNAUTHORIZED")
    })

    it("returns 404 in the standard envelope for an unknown dispute", async () => {
      const res = await request(app).get("/disputes/999-123").set("X-Request-Id", "req-404")
      expect(res.status).toBe(404)
      expect(res.body).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Dispute 999-123 not found",
          details: null,
          correlationId: "req-404",
        },
      })
    })
  })

  describe("GET /disputes", () => {
    it("returns an empty page when there are no disputes", async () => {
      const res = await request(app).get("/disputes")
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 })
    })

    it("lists disputes newest first with tallies", async () => {
      const first = await createDispute("1")
      const second = await createDispute("2")
      await vote(second, SIGNER_A, "ResolvedCounterparty")

      const res = await request(app).get("/disputes")
      expect(res.status).toBe(200)
      expect(res.body.total).toBe(2)
      expect(res.body.data.map((d: any) => d.dispute_id)).toEqual([second, first])
      expect(res.body.data[0]).toMatchObject({ counterparty_weight: 1, vote_count: 1 })
      expect(res.body.data[0]).not.toHaveProperty("votes")
    })

    it("filters by status", async () => {
      const open = await createDispute("1")
      const resolved = await createDispute("2")
      await vote(resolved, SIGNER_A, "ResolvedClaimant")
      await vote(resolved, SIGNER_B, "ResolvedClaimant")

      const raised = await request(app).get("/disputes").query({ status: "Raised" })
      expect(raised.body.data.map((d: any) => d.dispute_id)).toEqual([open])

      const done = await request(app).get("/disputes").query({ status: "Resolved" })
      expect(done.body.data.map((d: any) => d.dispute_id)).toEqual([resolved])
    })

    it("filters by settlement id", async () => {
      await createDispute("1")
      const target = await createDispute("7")
      await createDispute("8")

      const res = await request(app).get("/disputes").query({ settlement_id: "7" })
      expect(res.body.total).toBe(1)
      expect(res.body.data[0].dispute_id).toBe(target)
    })

    it("combines filters", async () => {
      const a = await createDispute("7")
      const b = await createDispute("7")
      await vote(b, SIGNER_A, "ResolvedClaimant")
      await vote(b, SIGNER_C, "ResolvedClaimant")
      await createDispute("8")

      const res = await request(app).get("/disputes").query({ settlement_id: "7", status: "Raised" })
      expect(res.body.data.map((d: any) => d.dispute_id)).toEqual([a])
    })

    it("paginates", async () => {
      const ids: string[] = []
      for (let i = 1; i <= 5; i++) ids.push(await createDispute(String(i)))

      const res = await request(app).get("/disputes").query({ page: 2, limit: 2 })
      expect(res.body).toMatchObject({ total: 5, page: 2, limit: 2, totalPages: 3 })
      expect(res.body.data.map((d: any) => d.dispute_id)).toEqual([ids[2], ids[1]])
    })

    it("includes voter identities for admins", async () => {
      const id = await createDispute("1")
      await vote(id, SIGNER_A, "ResolvedClaimant")

      const res = await request(app).get("/disputes").set("x-admin-key", ADMIN_KEY)
      expect(res.body.data[0].votes).toEqual([
        expect.objectContaining({ signer: SIGNER_A, vote: "ResolvedClaimant", weight: 1 }),
      ])
    })

    it.each([
      [{ status: "Open" }, "status"],
      [{ settlement_id: "abc" }, "settlement_id"],
      [{ limit: 0 }, "limit"],
      [{ limit: 101 }, "limit"],
      [{ page: 0 }, "page"],
    ])("rejects invalid query %o with a validation envelope", async (query, field) => {
      const res = await request(app).get("/disputes").query(query)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
      expect(res.body.error.details[0].field).toBe(field)
    })
  })

  describe("POST /disputes/:id/vote", () => {
    it("returns 404 when voting on an unknown dispute", async () => {
      const res = await vote("999-123", SIGNER_A, "ResolvedClaimant")
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe("NOT_FOUND")
    })

    it("returns 409 when a signer votes twice", async () => {
      const id = await createDispute("1")
      await vote(id, SIGNER_A, "ResolvedClaimant")
      const res = await vote(id, SIGNER_A, "ResolvedClaimant")
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe("CONFLICT")
    })

    it("returns 409 with the outcome once resolved", async () => {
      const id = await createDispute("1")
      await vote(id, SIGNER_A, "ResolvedClaimant", 2)
      const res = await vote(id, SIGNER_B, "ResolvedCounterparty")
      expect(res.status).toBe(409)
      expect(res.body.error.details).toEqual({ outcome: "ResolvedClaimant" })
    })

    it("uses the custom message for an invalid vote value", async () => {
      const id = await createDispute("1")
      const res = await request(app).post(`/disputes/${id}/vote`).send({ signer_address: SIGNER_A, vote: "Maybe" })
      expect(res.status).toBe(400)
      expect(res.body.error.details).toEqual([
        { field: "vote", message: "vote must be 'ResolvedClaimant' or 'ResolvedCounterparty'" },
      ])
    })
  })
})
