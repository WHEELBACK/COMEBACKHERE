import { describe, it, expect } from "vitest"
import { Keypair } from "soroban-client"
import {
  isValidStellarAddress,
  toSmallestUnit,
  fromSmallestUnit,
  parseDueDate,
  validateInvoiceForm,
  type InvoiceFormValues,
} from "../utils/invoiceForm"

const CUSTOMER = Keypair.random().publicKey()
const MERCHANT = Keypair.random().publicKey()
const NOW = new Date("2026-06-01T12:00:00").getTime()

const valid: InvoiceFormValues = {
  customer: CUSTOMER,
  amount: "25.50",
  token: "USDC",
  dueDate: "2026-06-02T12:00",
}

describe("isValidStellarAddress", () => {
  it("accepts valid public keys", () => {
    expect(isValidStellarAddress(CUSTOMER)).toBe(true)
  })

  it("rejects secrets, contract ids, bad checksums and junk", () => {
    expect(isValidStellarAddress(Keypair.random().secret())).toBe(false)
    expect(isValidStellarAddress("CDUMMYCONTRACT")).toBe(false)
    expect(isValidStellarAddress(CUSTOMER.slice(0, -1) + (CUSTOMER.endsWith("A") ? "B" : "A"))).toBe(false)
    expect(isValidStellarAddress("hello")).toBe(false)
  })
})

describe("toSmallestUnit", () => {
  it("converts decimal strings using the token decimals", () => {
    expect(toSmallestUnit("1", 7)).toBe(10_000_000n)
    expect(toSmallestUnit("25.5", 7)).toBe(255_000_000n)
    expect(toSmallestUnit("0.0000001", 7)).toBe(1n)
    expect(toSmallestUnit(".5", 7)).toBe(5_000_000n)
    expect(toSmallestUnit("3.", 7)).toBe(30_000_000n)
  })

  it("returns null for too many decimals or invalid input", () => {
    expect(toSmallestUnit("0.00000001", 7)).toBeNull()
    expect(toSmallestUnit("-1", 7)).toBeNull()
    expect(toSmallestUnit("1e5", 7)).toBeNull()
    expect(toSmallestUnit("abc", 7)).toBeNull()
    expect(toSmallestUnit(".", 7)).toBeNull()
    expect(toSmallestUnit("", 7)).toBeNull()
  })
})

describe("fromSmallestUnit", () => {
  it("formats base units as trimmed decimals", () => {
    expect(fromSmallestUnit(125_000_000, 7)).toBe("12.5")
    expect(fromSmallestUnit(10_000_000, 7)).toBe("1")
    expect(fromSmallestUnit(1, 7)).toBe("0.0000001")
    expect(fromSmallestUnit("0", 7)).toBe("0")
  })

  it("round-trips with toSmallestUnit", () => {
    expect(fromSmallestUnit(toSmallestUnit("1234.5678", 7) as bigint, 7)).toBe("1234.5678")
  })

  it("returns non-integer input unchanged", () => {
    expect(fromSmallestUnit(1.5, 7)).toBe("1.5")
  })
})

describe("parseDueDate", () => {
  it("parses datetime-local values into unix seconds", () => {
    expect(parseDueDate("2026-06-02T12:00")).toBe(Math.floor(new Date("2026-06-02T12:00").getTime() / 1000))
  })

  it("returns null for empty or invalid values", () => {
    expect(parseDueDate("")).toBeNull()
    expect(parseDueDate("not a date")).toBeNull()
  })
})

describe("validateInvoiceForm", () => {
  const validate = (overrides: Partial<InvoiceFormValues>) =>
    validateInvoiceForm({ ...valid, ...overrides }, { merchantAddress: MERCHANT, now: NOW })

  it("returns no errors for a valid form", () => {
    expect(validate({})).toEqual({})
  })

  it("requires every field", () => {
    const errors = validate({ customer: "", amount: "", dueDate: "" })
    expect(errors.customer).toMatch(/required/)
    expect(errors.amount).toMatch(/required/)
    expect(errors.dueDate).toMatch(/required/)
  })

  it("rejects invalid customer addresses", () => {
    expect(validate({ customer: "GABC" }).customer).toMatch(/valid Stellar address/)
  })

  it("rejects a customer address equal to the merchant", () => {
    expect(validate({ customer: MERCHANT }).customer).toMatch(/differ/)
  })

  it("trims whitespace around the customer address", () => {
    expect(validate({ customer: `  ${CUSTOMER}  ` }).customer).toBeUndefined()
  })

  it("rejects zero, negative and non-numeric amounts", () => {
    expect(validate({ amount: "0" }).amount).toMatch(/greater than zero/)
    expect(validate({ amount: "0.0000000" }).amount).toMatch(/greater than zero/)
    expect(validate({ amount: "-5" }).amount).toMatch(/Enter a number/)
    expect(validate({ amount: "ten" }).amount).toMatch(/Enter a number/)
  })

  it("rejects amounts with more decimals than the token supports", () => {
    expect(validate({ amount: "1.12345678" }).amount).toBe("USDC supports at most 7 decimal places")
  })

  it("rejects amounts above the safe integer range", () => {
    expect(validate({ amount: "999999999999" }).amount).toMatch(/too large/)
  })

  it("rejects due dates in the past or now", () => {
    expect(validate({ dueDate: "2026-05-31T12:00" }).dueDate).toMatch(/future/)
    expect(validate({ dueDate: "2026-06-01T12:00" }).dueDate).toMatch(/future/)
  })
})
