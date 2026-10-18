import type { InvoiceStatus } from "../types"

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:3000"

export interface ApiErrorDetail {
  field: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly details: ApiErrorDetail[]

  constructor(message: string, status: number, details: ApiErrorDetail[] = []) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.details = details
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    })
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0)
  }

  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string; details?: ApiErrorDetail[] })
    | null

  if (!res.ok) {
    throw new ApiError(
      body?.error || `Request failed with status ${res.status}`,
      res.status,
      Array.isArray(body?.details) ? body.details : []
    )
  }
  return body as T
}

export interface CreateInvoiceRequest {
  merchant_address: string
  customer_address: string
  token: string
  /** Amount in the token's smallest unit */
  amount: number
  /** Unix timestamp (seconds) */
  due_date: number
}

export interface CreateInvoiceResponse {
  invoice_id: string
  status: string
}

export function createInvoice(body: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
  return request<CreateInvoiceResponse>("/invoices", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Invoice as stored by the backend indexer (GET /invoices). */
export interface InvoiceSummary {
  invoice_id: string
  merchant_address: string
  token: string
  /** Amount in the token's smallest unit */
  amount: number
  /** Unix timestamp (seconds) */
  due_date: number
  reference?: string
  status: InvoiceStatus
  created_at: string
  updated_at: string
}

export interface InvoicePage {
  data: InvoiceSummary[]
  total: number
  /** Page cursor returned by the API (1-based) */
  page: number
  limit: number
  totalPages: number
}

export const INVOICE_PAGE_SIZE = 10

export interface ListInvoicesParams {
  merchant: string
  status?: InvoiceStatus | null
  page?: number
  limit?: number
}

export async function listInvoices(
  { merchant, status, page = 1, limit = INVOICE_PAGE_SIZE }: ListInvoicesParams,
  signal?: AbortSignal
): Promise<InvoicePage> {
  const query = new URLSearchParams({ merchant, page: String(page), limit: String(limit) })
  if (status) query.set("status", status)
  const result = await request<InvoicePage | null>(`/invoices?${query.toString()}`, { signal })
  if (!result || !Array.isArray(result.data)) {
    throw new ApiError("Unexpected response from server", 200)
  }
  return result
}
