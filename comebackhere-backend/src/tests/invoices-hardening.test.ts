import { describe, it, expect } from "vitest"
import { createInvoice, normalizeInvoiceId, type SorobanClient } from "../routes/invoices.js"

const MERCHANT = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const SECRET = "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ"
const CONTRACT = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const NETWORK = "Standalone Network ; February 2025"

// Any client call means validation did not short-circuit as expected.
const client = {
  getAccount: async () => { throw new Error("client should not be called") },
} as unknown as SorobanClient

const base = () => ({
  merchant_address: MERCHANT,
  token: "USDC",
  amount: 1_000_000,
  due_date: Math.floor(Date.now() / 1000) + 3600,
})

const call = (body: ReturnType<typeof base>) => createInvoice(body, client, CONTRACT, SECRET, NETWORK)

describe("createInvoice input hardening", () => {
  it("rejects a due_date in the past with 400", async () => {
    await expect(call({ ...base(), due_date: 1 })).rejects.toMatchObject({ status: 400 })
  })

  it("rejects a non-finite due_date with 400", async () => {
    await expect(call({ ...base(), due_date: Number.NaN })).rejects.toMatchObject({ status: 400 })
  })

  it.each([1.5, 0, -5, Number.MAX_SAFE_INTEGER + 10])("rejects amount %s with 400", async (amount) => {
    await expect(call({ ...base(), amount })).rejects.toMatchObject({ status: 400 })
  })

  it("rejects a blank token with 400", async () => {
    await expect(call({ ...base(), token: "   " })).rejects.toMatchObject({ status: 400 })
  })

  it("passes validation for a valid body and reaches the client", async () => {
    await expect(call(base())).rejects.toThrow("client should not be called")
  })
})

describe("normalizeInvoiceId", () => {
  it("strips leading zeros", () => {
    expect(normalizeInvoiceId("0042")).toBe("42")
  })

  it("accepts the u64 maximum", () => {
    expect(normalizeInvoiceId("18446744073709551615")).toBe("18446744073709551615")
  })

  it("rejects values above u64 max with 400", () => {
    expect(() => normalizeInvoiceId("18446744073709551616")).toThrowError(/64-bit/)
    try { normalizeInvoiceId("18446744073709551616") } catch (e) { expect((e as { status: number }).status).toBe(400) }
  })

  it("rejects non-numeric input with 400", () => {
    try { normalizeInvoiceId("abc"); throw new Error("no throw") } catch (e) { expect((e as { status: number }).status).toBe(400) }
  })
})
