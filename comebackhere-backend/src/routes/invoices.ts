import { Router, type Request, type Response } from "express"
import type { FindCursor, WithId } from "mongodb"
import { Keypair, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, SorobanRpc, xdr } from "stellar-sdk"
import { connectMongo, getInvoicesCollection, type InvoiceRecord, type InvoiceStatus } from "../db/mongo.js"
import { requireEnv } from "../lib/env.js"
import { asyncHandler, NotFoundError } from "../lib/errors.js"
import { cacheGet, cacheSet } from "../lib/cache.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { createInvoiceSchema, invoiceIdParamSchema } from "../schemas/index.js"

const router = Router()

export interface CreateInvoiceBody {
  merchant_address: string
  token: string
  amount: number
  due_date: number // Unix timestamp (seconds)
  reference?: string // Optional merchant-supplied reference, max 64 bytes
}

// Soroban interaction extracted so it can be replaced in tests
export type SorobanClient = {
  getAccount: (publicKey: string) => Promise<ConstructorParameters<typeof TransactionBuilder>[0]>
  simulateTransaction: (tx: Parameters<SorobanRpc.Server["simulateTransaction"]>[0]) => ReturnType<SorobanRpc.Server["simulateTransaction"]>
  sendTransaction: (tx: Parameters<SorobanRpc.Server["sendTransaction"]>[0]) => ReturnType<SorobanRpc.Server["sendTransaction"]>
  getTransaction: (hash: string) => ReturnType<SorobanRpc.Server["getTransaction"]>
}

function buildSorobanClient(rpcUrl: string): SorobanClient {
  const server = new SorobanRpc.Server(rpcUrl)
  return {
    getAccount: (pk) => server.getAccount(pk),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getTransaction: (hash) => server.getTransaction(hash),
  }
}

// Exported for testing — allows injecting a mock client
export async function createInvoice(
  body: CreateInvoiceBody,
  client: SorobanClient,
  contractId: string,
  signerSecret: string,
  networkPassphrase: string
): Promise<{ invoice_id: string; status: string }> {
  const keypair = Keypair.fromSecret(signerSecret)
  const contract = new Contract(contractId)

  const now = Math.floor(Date.now() / 1000)
  const expiresInSeconds = BigInt(body.due_date - now)

  const args = [
    nativeToScVal(body.merchant_address, { type: "address" }),
    nativeToScVal(body.amount, { type: "u64" }),
    nativeToScVal(body.amount, { type: "u64" }),
    nativeToScVal(expiresInSeconds, { type: "u64" }),
    nativeToScVal(null, { type: "void" }),
    body.reference
      ? nativeToScVal(body.reference, { type: "string" })
      : nativeToScVal(null, { type: "void" }),
  ]

  const account = await client.getAccount(keypair.publicKey())
  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("create_invoice", ...args))
    .setTimeout(30)
    .build()

  const simulated = await client.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw Object.assign(new Error(`Soroban simulation failed: ${(simulated as any).error}`), { status: 422 })
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simulated as any).build()
  prepared.sign(keypair)

  const sendResult = await client.sendTransaction(prepared)
  if (sendResult.status === "ERROR") {
    throw Object.assign(
      new Error(`Soroban submission failed: ${(sendResult as any).errorResult?.toXDR("base64")}`),
      { status: 422 }
    )
  }

  const hash = sendResult.hash
  let getResult: SorobanRpc.Api.GetTransactionResponse | null = null
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    getResult = await client.getTransaction(hash)
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) break
  }

  if (!getResult || getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw Object.assign(new Error("Transaction confirmation timeout"), { status: 504 })
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw Object.assign(new Error("Soroban transaction failed"), { status: 422 })
  }

  const returnVal = (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue
  const invoiceId = returnVal ? returnVal.u64()?.toString() ?? hash : hash

  return { invoice_id: invoiceId, status: "Pending" }
}

// ---------------------------------------------------------------------------
// List filters (shared by GET /invoices and GET /invoices/export.csv)
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES: InvoiceStatus[] = ["Pending", "Paid", "Expired", "Cancelled", "RefundRequested", "Released"]

export interface ListFilters {
  status?: InvoiceStatus
  merchant?: string
}

/** Reads the list filters from the query string; unknown statuses are ignored. */
export function parseListFilters(query: Request["query"]): ListFilters {
  const statusFilter = typeof query.status === "string" ? query.status : undefined
  const merchant = typeof query.merchant === "string" && query.merchant ? query.merchant : undefined
  const status = statusFilter && ALLOWED_STATUSES.includes(statusFilter as InvoiceStatus)
    ? (statusFilter as InvoiceStatus)
    : undefined
  return { status, merchant }
}

export function buildListFilter(filters: ListFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (filters.status) filter.status = filters.status
  if (filters.merchant) filter.merchant_address = filters.merchant
  return filter
}

// ---------------------------------------------------------------------------
// CSV export helpers
// ---------------------------------------------------------------------------

/** Decimals used for Stellar assets and SAC tokens unless configured otherwise. */
const DEFAULT_TOKEN_DECIMALS = 7

interface TokenMeta {
  symbol: string
  decimals: number
}

/**
 * Symbol and decimals for a token. TOKEN_METADATA may map token identifiers
 * (e.g. contract ids) to { symbol, decimals }; otherwise the stored token
 * value is used as the symbol with 7 decimals.
 */
export function resolveTokenMeta(token: string): TokenMeta {
  try {
    const configured = JSON.parse(process.env.TOKEN_METADATA ?? "{}")[token]
    if (configured) {
      return {
        symbol: configured.symbol ?? token,
        decimals: Number.isInteger(configured.decimals) ? configured.decimals : DEFAULT_TOKEN_DECIMALS,
      }
    }
  } catch {
    // Ignore malformed TOKEN_METADATA and fall back to defaults.
  }
  return { symbol: token, decimals: DEFAULT_TOKEN_DECIMALS }
}

/** Formats raw units as a decimal string without floating-point rounding: 12500000 → "1.25". */
export function formatTokenAmount(raw: number | string | bigint, decimals: number): string {
  const value = BigInt(typeof raw === "number" ? Math.trunc(raw) : raw)
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}

/**
 * Escapes one CSV field (RFC 4180): fields containing commas, quotes or line
 * breaks are quoted and inner quotes doubled. Text starting with = + - @ tab
 * or CR is prefixed with ' so spreadsheets do not evaluate it as a formula.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  let text = value instanceof Date ? value.toISOString() : String(value)
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_COLUMNS = [
  "invoice_id",
  "merchant_address",
  "token",
  "amount_raw",
  "amount",
  "status",
  "reference",
  "due_date",
  "created_at",
  "updated_at",
] as const

export function invoiceToCsvRow(invoice: InvoiceRecord): string {
  const { symbol, decimals } = resolveTokenMeta(invoice.token)
  const fields = [
    invoice.invoice_id,
    invoice.merchant_address,
    invoice.token,
    String(invoice.amount),
    `${formatTokenAmount(invoice.amount, decimals)} ${symbol}`,
    invoice.status,
    invoice.reference,
    Number.isFinite(invoice.due_date) ? new Date(invoice.due_date * 1000) : invoice.due_date,
    invoice.created_at,
    invoice.updated_at,
  ]
  return fields.map(escapeCsvField).join(",") + "\r\n"
}

/** Resolves once `res` can take more data, or when the client has gone away. */
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done)
      res.off("close", done)
      resolve()
    }
    res.on("drain", done)
    res.on("close", done)
  })
}

/**
 * @openapi
 * /invoices/export.csv:
 *   get:
 *     tags: [Invoices]
 *     summary: Export invoices as CSV
 *     description: >
 *       Streams every invoice matching the same filters as GET /invoices
 *       (newest first, no pagination) as a CSV download. Amounts are given in
 *       raw units (amount_raw) and human-readable form with the token symbol
 *       (amount). Dates are ISO 8601 in UTC.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [Pending, Paid, Expired, Cancelled, RefundRequested, Released]
 *       - in: query
 *         name: merchant
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       500:
 *         description: Database error before streaming started
 */
router.get("/export.csv", async (req: Request, res: Response) => {
  const filters = parseListFilters(req.query)
  const date = new Date().toISOString().slice(0, 10)
  const filename = `invoices${filters.status ? `-${filters.status.toLowerCase()}` : ""}-${date}.csv`

  let cursor: FindCursor<WithId<InvoiceRecord>> | undefined
  try {
    const db = await connectMongo()
    cursor = getInvoicesCollection(db).find(buildListFilter(filters)).sort({ created_at: -1 })

    // Rows are written as they arrive from the Mongo cursor, so memory use
    // stays flat regardless of how many invoices are exported. Headers are
    // sent with the first write, which lets errors before it return JSON.
    let started = false
    const write = async (chunk: string) => {
      if (!started) {
        started = true
        res.status(200)
        res.setHeader("Content-Type", "text/csv; charset=utf-8")
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
        res.setHeader("Cache-Control", "no-store")
        res.write(CSV_COLUMNS.join(",") + "\r\n")
      }
      if (!res.write(chunk)) await waitForDrain(res)
    }

    for await (const invoice of cursor) {
      if (res.destroyed) break
      await write(invoiceToCsvRow(invoice))
    }
    if (!started) await write("")
    res.end()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) {
      res.status((err as any)?.status ?? 500).json({ error: message })
    } else {
      // Mid-stream failure: abort so the client sees a truncated download
      // rather than a file that silently looks complete.
      console.error("[invoices] CSV export failed mid-stream:", message)
      res.destroy(err instanceof Error ? err : new Error(message))
    }
  } finally {
    await cursor?.close().catch(() => {})
  }
})

/**
 * @openapi
 * /invoices:
 *   get:
 *     tags: [Invoices]
 *     summary: List invoices with pagination and filtering
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [Pending, Paid, Expired, Cancelled, RefundRequested, Released]
 *       - in: query
 *         name: merchant
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated invoice list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Invoice'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 */
router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20))
  const { status, merchant: merchantFilter } = parseListFilters(req.query)

  const cacheKey = `invoices:${page}:${limit}:${status ?? "all"}:${merchantFilter ?? "all"}`

  const cached = await cacheGet<{ data: InvoiceRecord[]; total: number; page: number; limit: number; totalPages: number }>(cacheKey)
  if (cached) {
    res.json(cached)
    return
  }

  try {
    const db = await connectMongo()
    const collection = getInvoicesCollection(db)

    const filter = buildListFilter({ status, merchant: merchantFilter })

    const total = await collection.countDocuments(filter)
    const totalPages = Math.ceil(total / limit)
    const skip = (page - 1) * limit

    const data = await collection
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

    const result = {
      data,
      total,
      page,
      limit,
      totalPages,
    }

    await cacheSet(cacheKey, result, 30)
    res.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }

  await cacheSet(cacheKey, result, 30)
  res.json(result)
}))

/**
 * @openapi
 * /invoices/{id}:
 *   get:
 *     tags: [Invoices]
 *     summary: Fetch invoice status by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Positive integer string invoice ID
 *     responses:
 *       200:
 *         description: Invoice found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoice_id:
 *                   type: string
 *                   example: "42"
 *                 status:
 *                   $ref: '#/components/schemas/InvoiceStatus'
 *       400:
 *         description: Invalid invoice ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Invoice not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       503:
 *         description: Service misconfiguration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:id", validateParams(invoiceIdParamSchema), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params

  const env = requireEnv({ invoiceContractId: "INVOICE_CONTRACT_ID" })

  const server = new SorobanRpc.Server(env.rpcUrl)
  const contract = new Contract(env.invoiceContractId)

  // Build a read-only ledger entry query for the invoice
  const ledgerKey = contract.getFootprint()
  void ledgerKey // used below via getLedgerEntries

  // Query the contract's ledger entry directly
  const entries = await server.getLedgerEntries(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Contract(env.invoiceContractId).address().toScAddress(),
        key: nativeToScVal(BigInt(id), { type: "u64" }),
        durability: xdr.ContractDataDurability.persistent(),
      })
    )
  )

  if (!entries.entries.length) {
    throw new NotFoundError("Invoice not found")
  }

  res.json({ invoice_id: id, status: "Pending" })
}))

/**
 * @openapi
 * /invoices:
 *   post:
 *     tags: [Invoices]
 *     summary: Create a new invoice
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [merchant_address, token, amount, due_date]
 *             properties:
 *               merchant_address:
 *                 type: string
 *                 description: Valid Stellar public key (G…)
 *                 example: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
 *               token:
 *                 type: string
 *                 example: "USDC"
 *               amount:
 *                 type: integer
 *                 description: Positive number in stroops / smallest unit
 *                 example: 1000000
 *               due_date:
 *                 type: integer
 *                 description: Future Unix timestamp (seconds)
 *                 example: 1720000000
 *               reference:
 *                 type: string
 *                 description: Optional merchant-supplied reference (e.g. an order ID), max 64 bytes
 *                 maxLength: 64
 *                 example: "order-12345"
 *     responses:
 *       201:
 *         description: Invoice created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoice_id:
 *                   type: string
 *                   example: "1"
 *                 status:
 *                   $ref: '#/components/schemas/InvoiceStatus'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Soroban simulation or transaction failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       503:
 *         description: Service misconfiguration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       504:
 *         description: Transaction confirmation timeout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/", validateBody(createInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const env = requireEnv({
    invoiceContractId: "INVOICE_CONTRACT_ID",
    signerSecret: "SIGNER_SECRET_KEY",
  })

  const client = buildSorobanClient(env.rpcUrl)
  const result = await createInvoice(
    req.body as CreateInvoiceBody,
    client,
    env.invoiceContractId,
    env.signerSecret,
    env.networkPassphrase
  )

  const db = await connectMongo()
  const collection = getInvoicesCollection(db)
  const body = req.body as CreateInvoiceBody
  const now = new Date()
  await collection.insertOne({
    invoice_id: result.invoice_id,
    merchant_address: body.merchant_address,
    token: body.token,
    amount: body.amount,
    due_date: body.due_date,
    reference: body.reference,
    status: "Pending",
    created_at: now,
    updated_at: now,
  })

  res.status(201).json(result)
}))

export default router
