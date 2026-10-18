import { Router, type Request, type Response } from "express"
import { Keypair, nativeToScVal } from "stellar-sdk"
import { buildSorobanClient, simulateContractRead, submitContractCall, type SorobanClient } from "../lib/soroban.js"
import { requireEnv } from "../lib/env.js"
import { asyncHandler, ContractError, parseContractErrorCode } from "../lib/errors.js"
import { validateParams } from "../middleware/validate.js"
import { invoiceActionIdParamSchema } from "../schemas/index.js"

const router = Router()

type InvoiceAction = "cancel_invoiced" | "request_refund"
type InvoiceStatus = "Pending" | "Paid" | "Expired" | "Cancelled" | "RefundRequested" | "Released"

interface InvoiceActionEnv {
  rpcUrl: string
  invoiceContractId: string
  signerSecret: string
  networkPassphrase: string
}

export async function getInvoiceStatus(
  invoiceId: string,
  env: InvoiceActionEnv,
  client: SorobanClient = buildSorobanClient(env.rpcUrl),
): Promise<InvoiceStatus> {
  const signer = Keypair.fromSecret(env.signerSecret)
  try {
    const value = await simulateContractRead(
      client,
      env.invoiceContractId,
      "get_invoice_status",
      [nativeToScVal(BigInt(invoiceId), { type: "u64" })],
      signer.publicKey(),
      env.networkPassphrase,
    )
    const status = value.vec()?.[0]?.sym()?.toString()
    if (!status) throw Object.assign(new Error("Invalid invoice status returned by contract"), { status: 422 })
    return status as InvoiceStatus
  } catch (err) {
    const code = parseContractErrorCode(err instanceof Error ? err.message : String(err))
    if (code === 4) throw new ContractError(4, "Invoice not found", 404)
    throw err
  }
}

export async function applyInvoiceAction(
  action: InvoiceAction,
  invoiceId: string,
  env: InvoiceActionEnv,
  client: SorobanClient = buildSorobanClient(env.rpcUrl),
): Promise<{ invoice_id: string; status: "Cancelled" | "RefundRequested"; tx_hash: string }> {
  const signer = Keypair.fromSecret(env.signerSecret)
  const currentStatus = await getInvoiceStatus(invoiceId, env, client)

  if (action === "request_refund" && currentStatus !== "Paid") {
    if (currentStatus === "RefundRequested") {
      throw new ContractError(11, "A refund has already been requested", 409)
    }
    throw new ContractError(4, `Cannot request a refund while invoice status is ${currentStatus}`, 409)
  }

  try {
    const txHash = await submitContractCall(
      client,
      env.invoiceContractId,
      action,
      [
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(signer.publicKey(), { type: "address" }),
      ],
      env.signerSecret,
      env.networkPassphrase,
    )

    return {
      invoice_id: invoiceId,
      status: action === "request_refund" || currentStatus === "Paid" ? "RefundRequested" : "Cancelled",
      tx_hash: txHash,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = parseContractErrorCode(message)
    if (code === 1 || code === 9) throw new ContractError(code, "Caller is not allowed to perform this invoice action", 403)
    if (code === 4) {
      throw new ContractError(4, "Invoice not found or no longer eligible for this action", action === "request_refund" ? 409 : 404)
    }
    if (code === 7 || code === 10 || code === 11 || code === 18) {
      throw new ContractError(code, "Invoice state does not allow this action", 409)
    }
    throw err
  }
}

/**
 * @openapi
 * /invoices/{id}/cancel:
 *   post:
 *     tags: [Invoices]
 *     summary: Cancel an invoice
 *     description: Cancelling a Paid invoice starts the refund flow and returns RefundRequested; a Pending invoice becomes Cancelled.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[1-9]\d*$'
 *     responses:
 *       200:
 *         description: Invoice cancellation submitted
 *       400:
 *         description: Invalid invoice ID
 *       403:
 *         description: Caller is not allowed to cancel this invoice
 *       404:
 *         description: Invoice not found
 *       409:
 *         description: Invoice state does not allow cancellation
 */
router.post("/:id/cancel", validateParams(invoiceActionIdParamSchema), asyncHandler(async (req: Request, res: Response) => {
  const env = requireEnv({ invoiceContractId: "INVOICE_CONTRACT_ID", signerSecret: "SIGNER_SECRET_KEY" })
  const result = await applyInvoiceAction("cancel_invoiced", req.params.id, env)
  res.status(200).json(result)
}))

/**
 * @openapi
 * /invoices/{id}/refund:
 *   post:
 *     tags: [Invoices]
 *     summary: Request an invoice refund
 *     description: Requests a refund for a Paid invoice and returns its updated RefundRequested status.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[1-9]\d*$'
 *     responses:
 *       200:
 *         description: Refund request submitted
 *       400:
 *         description: Invalid invoice ID
 *       403:
 *         description: Caller is not the invoice customer
 *       404:
 *         description: Invoice not found
 *       409:
 *         description: Invoice is not Paid or a refund is already pending
 */
router.post("/:id/refund", validateParams(invoiceActionIdParamSchema), asyncHandler(async (req: Request, res: Response) => {
  const env = requireEnv({ invoiceContractId: "INVOICE_CONTRACT_ID", signerSecret: "SIGNER_SECRET_KEY" })
  const result = await applyInvoiceAction("request_refund", req.params.id, env)
  res.status(200).json(result)
}))

export default router