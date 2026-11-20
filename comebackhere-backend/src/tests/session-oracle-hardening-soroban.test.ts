import { describe, it, expect } from "vitest"
import { Keypair, StrKey } from "stellar-sdk"
import { assertContractId, assertHolderAddress, assertMethodName } from "../lib/soroban-input-guards.js"

const contract = StrKey.encodeContract(Buffer.alloc(32, 7))
const account = Keypair.random().publicKey()

describe("soroban input guards", () => {
  it("accepts valid contract ids and rejects junk", () => {
    expect(assertContractId(contract)).toBe(contract)
    expect(() => assertContractId("not-a-contract")).toThrow("Invalid contract id")
    expect(() => assertContractId(account)).toThrow()
    expect(() => assertContractId(undefined)).toThrow()
  })
  it("accepts account or contract holders", () => {
    expect(assertHolderAddress(account)).toBe(account)
    expect(assertHolderAddress(contract)).toBe(contract)
    expect(() => assertHolderAddress("G123")).toThrow()
  })
  it("restricts method names", () => {
    expect(assertMethodName("balance")).toBe("balance")
    expect(() => assertMethodName("bal; drop")).toThrow()
    expect(() => assertMethodName("a".repeat(33))).toThrow()
  })
  it("errors carry status 400", () => {
    try { assertContractId("x") } catch (e) { expect((e as { status: number }).status).toBe(400) }
  })
})
