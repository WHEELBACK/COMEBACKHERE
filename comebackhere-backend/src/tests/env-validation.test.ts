import { describe, it, expect } from "vitest"
import { validateEnv, findInvalidStellarVars } from "../lib/env.js"

// Valid strkeys (deterministic, not real deployments)
const CONTRACT_A = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526"
const CONTRACT_B = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ"
const ACCOUNT = "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG"
const SECRET = "SABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGC45"

/** Flips the last character, which breaks the strkey checksum. */
const typo = (key: string) => key.slice(0, -1) + (key.endsWith("A") ? "B" : "A")

const FULL_ENV: Record<string, string> = {
  MONGODB_URI: "mongodb://localhost:27017",
  REDIS_URL: "redis://localhost:6379",
  SOROBAN_RPC_URL: "http://localhost:8000",
  TREASURY_CONTRACT_ID: CONTRACT_A,
  INVOICE_CONTRACT_ID: CONTRACT_B,
  ADMIN_KEY: "secret-admin",
  WEBHOOK_SECRET: "secret-webhook",
}

describe("validateEnv", () => {
  it("does not throw when all required vars are present", () => {
    expect(() => validateEnv(FULL_ENV)).not.toThrow()
  })

  it("throws when a single required var is missing", () => {
    const env = { ...FULL_ENV }
    delete env.MONGODB_URI

    expect(() => validateEnv(env)).toThrow(/MONGODB_URI/)
  })

  it("lists every missing var in one error, not just the first one found", () => {
    const env = { ...FULL_ENV }
    delete env.REDIS_URL
    delete env.WEBHOOK_SECRET

    let err: Error | null = null
    try {
      validateEnv(env)
    } catch (e) {
      err = e as Error
    }

    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/REDIS_URL/)
    expect(err!.message).toMatch(/WEBHOOK_SECRET/)
  })

  it("includes all seven required vars in the error when none are set", () => {
    let err: Error | null = null
    try {
      validateEnv({})
    } catch (e) {
      err = e as Error
    }

    expect(err).not.toBeNull()
    const message = err!.message
    expect(message).toMatch(/MONGODB_URI/)
    expect(message).toMatch(/REDIS_URL/)
    expect(message).toMatch(/SOROBAN_RPC_URL/)
    expect(message).toMatch(/TREASURY_CONTRACT_ID/)
    expect(message).toMatch(/INVOICE_CONTRACT_ID/)
    expect(message).toMatch(/ADMIN_KEY/)
    expect(message).toMatch(/WEBHOOK_SECRET/)
  })

  it("throws with a human-readable hint to set the missing variables", () => {
    expect(() => validateEnv({})).toThrow(/Set the above variables/)
  })
})

describe("validateEnv — Stellar identifiers", () => {
  const errorFor = (env: Record<string, string>): string => {
    try {
      validateEnv(env)
    } catch (e) {
      return (e as Error).message
    }
    return ""
  }

  describe.each(["TREASURY_CONTRACT_ID", "INVOICE_CONTRACT_ID", "USDC_CONTRACT_ID", "COMPLIANCE_CONTRACT_ID", "SETTLEMENT_CONTRACT_ID"])(
    "contract id %s",
    (name) => {
      it("accepts a valid C... contract id", () => {
        expect(() => validateEnv({ ...FULL_ENV, [name]: CONTRACT_A })).not.toThrow()
      })

      it.each([
        ["a checksum typo", typo(CONTRACT_A)],
        ["a stray character", CONTRACT_A + "X"],
        ["a truncated value", CONTRACT_A.slice(0, 20)],
        ["a lowercase value", CONTRACT_A.toLowerCase()],
        ["an account key instead of a contract", ACCOUNT],
        ["a placeholder", "CTREASURY"],
      ])("rejects %s and names the variable", (_label, value) => {
        const message = errorFor({ ...FULL_ENV, [name]: value })
        expect(message).toContain(name)
        expect(message).toMatch(/not a valid Stellar contract id \(expected C\.\.\./)
      })
    },
  )

  describe("account key ADMIN_PUBLIC_KEY", () => {
    it("accepts a valid G... key", () => {
      expect(() => validateEnv({ ...FULL_ENV, ADMIN_PUBLIC_KEY: ACCOUNT })).not.toThrow()
    })

    it.each([
      ["a checksum typo", typo(ACCOUNT)],
      ["a contract id instead of an account", CONTRACT_A],
      ["a secret seed instead of an account", SECRET],
      ["a leading space", ` ${ACCOUNT}`],
    ])("rejects %s and names the variable", (_label, value) => {
      const message = errorFor({ ...FULL_ENV, ADMIN_PUBLIC_KEY: value })
      expect(message).toContain("ADMIN_PUBLIC_KEY")
      expect(message).toMatch(/not a valid Stellar account key \(expected G\.\.\./)
    })
  })

  describe("secret seed SIGNER_SECRET_KEY", () => {
    it("accepts a valid S... seed", () => {
      expect(() => validateEnv({ ...FULL_ENV, SIGNER_SECRET_KEY: SECRET })).not.toThrow()
    })

    it("rejects an invalid seed without echoing its value", () => {
      const bad = typo(SECRET)
      const message = errorFor({ ...FULL_ENV, SIGNER_SECRET_KEY: bad })
      expect(message).toContain("SIGNER_SECRET_KEY")
      expect(message).not.toContain(bad)
    })
  })

  it("skips optional identifiers that are not set", () => {
    expect(findInvalidStellarVars(FULL_ENV)).toEqual([])
  })

  it("reports missing and malformed variables together in one error", () => {
    const env = { ...FULL_ENV, INVOICE_CONTRACT_ID: "CINVOICE" }
    delete (env as Record<string, string | undefined>).REDIS_URL

    const message = errorFor(env)
    expect(message).toMatch(/REDIS_URL is missing/)
    expect(message).toMatch(/INVOICE_CONTRACT_ID is not a valid Stellar contract id/)
  })
})
