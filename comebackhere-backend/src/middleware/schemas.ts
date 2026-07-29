import { z } from "zod"

export const createInvoiceSchema = z.object({
  merchant_address: z.string().min(1, "merchant_address is required"),
  token: z.string().min(1, "token is required"),
  amount: z.number().positive("amount must be a positive number"),
  due_date: z.number().int().positive("due_date must be a positive Unix timestamp"),
})

export const createDisputeSchema = z.object({
  claimant_address: z.string().min(1, "claimant_address is required"),
  settlement_id: z.string().regex(/^\d+$/, "settlement_id must be a positive integer string"),
  reason: z.string().optional(),
})

export const disputeVoteSchema = z.object({
  signer_address: z.string().min(1, "signer_address is required"),
  weight: z.number().int().positive("weight must be a positive integer"),
})

export const approveSettlementSchema = z.object({
  settlement_id: z.number().int().positive("settlement_id must be a positive integer"),
})

export const executeSettlementSchema = z.object({
  settlement_id: z.number().int().positive("settlement_id must be a positive integer"),
  token_contract: z.string().optional(),
})

export const graceWindowSchema = z.object({
  grace_window_seconds: z.number().int().positive("grace_window_seconds must be a positive integer"),
})

export const thresholdUpdateSchema = z.object({
  threshold: z.number().int().positive("threshold must be a positive integer"),
  caller: z.string().optional(),
})
