import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { Keypair } from "stellar-sdk"
import { createApp } from "../app.js"
import * as mongoModule from "../db/mongo.js"
import { hashMerchantApiKey, requireMerchantApiKey } from "../middleware/apiKey.js"

const VALID_MERCHANT = Keypair.random().publicKey()
const OTHER_MERCHANT = Keypair.random().publicKey()
const ADMIN_KEY = "test-secret-admin-key"

describe("Merchant API Keys Management (/api/merchant-keys)", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>
  let mockKeys: any[]

  beforeEach(() => {
    envBackup = { ADMIN_KEY: process.env.ADMIN_KEY }
    process.env.ADMIN_KEY = ADMIN_KEY
    mockKeys = []

    const mockCollection = {
      insertOne: vi.fn(async (doc: any) => {
        mockKeys.push({ ...doc })
        return { insertedId: doc.key_id }
      }),
      find: vi.fn((filter: any = {}) => ({
        sort: vi.fn(() => ({
          toArray: vi.fn(async () => {
            return mockKeys.filter((k) => {
              if (filter.merchant_address && k.merchant_address !== filter.merchant_address) {
                return false
              }
              return true
            })
          }),
        })),
      })),
      findOne: vi.fn(async (filter: any) => {
        return (
          mockKeys.find((k) => {
            for (const [key, val] of Object.entries(filter)) {
              if (key === "revoked_at" && val && typeof val === "object" && "$exists" in (val as any)) {
                if ((val as any).$exists === false && k.revoked_at !== undefined) return false
              } else if (k[key] !== val) {
                return false
              }
            }
            return true
          }) ?? null
        )
      }),
      updateOne: vi.fn(async (filter: any, update: any) => {
        const item = mockKeys.find((k) => {
          for (const [key, val] of Object.entries(filter)) {
            if (key === "revoked_at" && val && typeof val === "object" && "$exists" in (val as any)) {
              if ((val as any).$exists === false && k.revoked_at !== undefined) return false
            } else if (k[key] !== val) {
              return false
            }
          }
          return true
        })
        if (!item) return { matchedCount: 0, modifiedCount: 0 }
        if (update.$set) Object.assign(item, update.$set)
        return { matchedCount: 1, modifiedCount: 1 }
      }),
      updateMany: vi.fn(async (filter: any, update: any) => {
        let count = 0
        for (const k of mockKeys) {
          let matches = true
          if (filter.merchant_address && k.merchant_address !== filter.merchant_address) matches = false
          if (filter.key_id && filter.key_id.$ne && k.key_id === filter.key_id.$ne) matches = false
          if (filter.revoked_at && filter.revoked_at.$exists === false && k.revoked_at !== undefined) matches = false
          if (matches) {
            count++
            if (update.$set) Object.assign(k, update.$set)
          }
        }
        return { matchedCount: count, modifiedCount: count }
      }),
    }

    const mockDb = {
      collection: vi.fn((name: string) => {
        if (name === "merchant_api_keys") return mockCollection
        return mockCollection
      }),
    }

    vi.spyOn(mongoModule, "connectMongo").mockResolvedValue(mockDb as any)
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    vi.restoreAllMocks()
  })

  describe("Authorization & Validation", () => {
    it("returns 401 when no authorization is provided for GET", async () => {
      const res = await request(app).get("/api/merchant-keys")
      expect(res.status).toBe(401)
    })

    it("returns 403 when invalid admin key is provided", async () => {
      const res = await request(app)
        .get("/api/merchant-keys")
        .set("X-Admin-Key", "invalid-key")
      expect(res.status).toBe(403)
    })

    it("returns 403 when invalid Stellar address is provided as merchant address", async () => {
      const res = await request(app)
        .get("/api/merchant-keys")
        .set("X-Merchant-Address", "not-a-valid-address")
      expect(res.status).toBe(403)
    })
  })

  describe("API Key Creation & Secret Visibility", () => {
    it("creates a key and returns plaintext secret ONLY at creation", async () => {
      const res = await request(app)
        .post("/api/merchant-keys")
        .set("X-Merchant-Address", VALID_MERCHANT)
        .send({ merchant_address: VALID_MERCHANT })

      expect(res.status).toBe(201)
      expect(res.body.key_id).toBeDefined()
      expect(res.body.merchant_address).toBe(VALID_MERCHANT)
      expect(res.body.api_key).toMatch(/^ch_[0-9a-f]{64}$/)
      expect(res.body.is_active).toBe(true)

      // Verify that database does not store plaintext key
      expect(mockKeys[0].api_key).toBeUndefined()
      expect(mockKeys[0].key_hash).toBe(hashMerchantApiKey(res.body.api_key))

      // GET inspects metadata: secret must NOT be exposed in list
      const listRes = await request(app)
        .get(`/api/merchant-keys?merchant_address=${VALID_MERCHANT}`)
        .set("X-Merchant-Address", VALID_MERCHANT)

      expect(listRes.status).toBe(200)
      expect(listRes.body).toHaveLength(1)
      expect(listRes.body[0].key_id).toBe(res.body.key_id)
      expect(listRes.body[0].merchant_address).toBe(VALID_MERCHANT)
      expect(listRes.body[0].api_key).toBeUndefined()
      expect(listRes.body[0].key_hash).toBeUndefined()
      expect(listRes.body[0].is_active).toBe(true)
    })
  })

  describe("Metadata Inspection (last_used_at)", () => {
    it("reflects last_used_at and revoked_at metadata in list", async () => {
      const createRes = await request(app)
        .post("/api/merchant-keys")
        .set("X-Merchant-Address", VALID_MERCHANT)
        .send({ merchant_address: VALID_MERCHANT })

      const keyId = createRes.body.key_id

      // Initial state: last_used_at is undefined
      let listRes = await request(app)
        .get(`/api/merchant-keys?merchant_address=${VALID_MERCHANT}`)
        .set("X-Merchant-Address", VALID_MERCHANT)

      expect(listRes.body[0].last_used_at).toBeUndefined()

      // Simulate API key usage updating last_used_at
      const usedDate = new Date()
      mockKeys[0].last_used_at = usedDate

      listRes = await request(app)
        .get(`/api/merchant-keys?merchant_address=${VALID_MERCHANT}`)
        .set("X-Merchant-Address", VALID_MERCHANT)

      expect(listRes.body[0].last_used_at).toBeDefined()
    })
  })

  describe("Rotation & Revocation", () => {
    it("rotates key: revokes existing active keys and returns new secret", async () => {
      // Create initial key
      const key1 = await request(app)
        .post("/api/merchant-keys")
        .set("X-Merchant-Address", VALID_MERCHANT)
        .send({ merchant_address: VALID_MERCHANT })
      expect(key1.status).toBe(201)

      // Rotate key
      const rotateRes = await request(app)
        .post("/api/merchant-keys/rotate")
        .set("X-Merchant-Address", VALID_MERCHANT)
        .send({ merchant_address: VALID_MERCHANT })

      expect(rotateRes.status).toBe(201)
      expect(rotateRes.body.api_key).toBeDefined()
      expect(rotateRes.body.key_id).not.toBe(key1.body.key_id)
      expect(rotateRes.body.rotated_at).toBeDefined()

      // Check that key1 was revoked
      const oldKey = mockKeys.find((k) => k.key_id === key1.body.key_id)
      expect(oldKey.revoked_at).toBeDefined()

      const newKey = mockKeys.find((k) => k.key_id === rotateRes.body.key_id)
      expect(newKey.revoked_at).toBeUndefined()
    })

    it("revokes active key via DELETE", async () => {
      const createRes = await request(app)
        .post("/api/merchant-keys")
        .set("X-Merchant-Address", VALID_MERCHANT)
        .send({ merchant_address: VALID_MERCHANT })

      const keyId = createRes.body.key_id

      const delRes = await request(app)
        .delete(`/api/merchant-keys/${keyId}`)
        .set("X-Merchant-Address", VALID_MERCHANT)

      expect(delRes.status).toBe(204)

      const key = mockKeys.find((k) => k.key_id === keyId)
      expect(key.revoked_at).toBeDefined()

      // Attempting to revoke again returns 404
      const secondDel = await request(app)
        .delete(`/api/merchant-keys/${keyId}`)
        .set("X-Merchant-Address", VALID_MERCHANT)

      expect(secondDel.status).toBe(404)
    })
  })
})
