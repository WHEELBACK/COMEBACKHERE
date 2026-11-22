import { pruneExpiring } from "./bounded-map.js"

const JURISDICTION_RE = /^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$/
const MERCHANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_TAX_BPS = 10_000
const MAX_TAXABLE_AMOUNT = 1_000_000_000_000

export interface TaxRule {
  jurisdiction: string
  rateBps: number
  expiresAt: number
}

export interface TaxCalculationResult {
  jurisdiction: string
  subtotal: number
  rateBps: number
  taxAmount: number
  total: number
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

function unauthorized(message: string): never {
  throw Object.assign(new Error(message), { status: 401 })
}

export function validateJurisdiction(value: unknown): string {
  if (typeof value !== "string" || !JURISDICTION_RE.test(value)) {
    badRequest("Invalid tax jurisdiction code")
  }
  return value
}

export function validateMerchantActor(value: unknown): string {
  if (typeof value !== "string" || !MERCHANT_ID_RE.test(value)) {
    unauthorized("Unauthorized or invalid merchant actor")
  }
  return value
}

export function validateTaxRateBps(rateBps: unknown): number {
  if (
    typeof rateBps !== "number" ||
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > MAX_TAX_BPS
  ) {
    badRequest("Invalid tax rate basis points")
  }
  return rateBps
}

export function validateTaxableAmount(amount: unknown): number {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > MAX_TAXABLE_AMOUNT
  ) {
    badRequest("Invalid taxable amount")
  }
  return amount
}

export class TaxCalculator {
  private readonly rules = new Map<string, TaxRule>()
  private readonly maxRules: number
  private readonly ttlMs: number

  constructor(options?: { maxRules?: number; ttlMs?: number }) {
    this.maxRules = options?.maxRules ?? 256
    this.ttlMs = options?.ttlMs ?? 300_000
  }

  setRule(
    merchantActor: unknown,
    jurisdictionInput: unknown,
    rateBpsInput: unknown,
    now = Date.now(),
  ): TaxRule {
    validateMerchantActor(merchantActor)
    const jurisdiction = validateJurisdiction(jurisdictionInput)
    const rateBps = validateTaxRateBps(rateBpsInput)

    pruneExpiring(this.rules, this.maxRules - 1, now)
    const rule: TaxRule = {
      jurisdiction,
      rateBps,
      expiresAt: now + this.ttlMs,
    }
    this.rules.set(jurisdiction, rule)
    return rule
  }

  calculate(
    merchantActor: unknown,
    jurisdictionInput: unknown,
    subtotalInput: unknown,
    now = Date.now(),
  ): TaxCalculationResult {
    validateMerchantActor(merchantActor)
    const jurisdiction = validateJurisdiction(jurisdictionInput)
    const subtotal = validateTaxableAmount(subtotalInput)

    const rule = this.rules.get(jurisdiction)
    const rateBps = rule && rule.expiresAt > now ? rule.rateBps : 0
    if (rule && rule.expiresAt <= now) {
      this.rules.delete(jurisdiction)
    }

    const taxAmount = Math.round(((subtotal * rateBps) / 10_000) * 1e7) / 1e7
    const total = Math.round((subtotal + taxAmount) * 1e7) / 1e7

    return {
      jurisdiction,
      subtotal,
      rateBps,
      taxAmount,
      total,
    }
  }

  size(): number {
    return this.rules.size
  }
}
