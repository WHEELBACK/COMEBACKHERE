import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Keypair } from "soroban-client"
import { CreateInvoice } from "../components/CreateInvoice"
import { toDateTimeLocal } from "../utils/invoiceForm"

vi.mock("../components/InvoiceQRCode", () => ({
  InvoiceQRCode: ({ invoiceId }: { invoiceId: string }) => <div data-testid="invoice-qr">QR {invoiceId}</div>,
}))

const MERCHANT = Keypair.random().publicKey()
const CUSTOMER = Keypair.random().publicKey()
const TOMORROW = toDateTimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000))

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Customer address/), CUSTOMER)
  await user.type(screen.getByLabelText(/Amount/), "12.5")
  await user.selectOptions(screen.getByLabelText(/Token/), "USDC")
  await user.type(screen.getByLabelText(/Due date/), TOMORROW)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("CreateInvoice — empty state", () => {
  it("renders every field and no errors", () => {
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    expect(screen.getByLabelText(/Customer address/)).toHaveValue("")
    expect(screen.getByLabelText(/Amount/)).toHaveValue("")
    expect(screen.getByLabelText(/Token/)).toHaveValue("USDC")
    expect(screen.getByLabelText(/Due date/)).toHaveValue("")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("disables submit and explains why when no wallet is connected", () => {
    render(<CreateInvoice merchantAddress={null} />)
    expect(screen.getByTestId("create-invoice-submit")).toBeDisabled()
    expect(screen.getByText(/Connect your wallet to create invoices/)).toBeInTheDocument()
  })
})

describe("CreateInvoice — validation", () => {
  it("shows all field errors on submit and does not call the API", async () => {
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await user.click(screen.getByTestId("create-invoice-submit"))

    expect(screen.getByText("Customer address is required")).toBeInTheDocument()
    expect(screen.getByText("Amount is required")).toBeInTheDocument()
    expect(screen.getByText("Due date is required")).toBeInTheDocument()
    expect(screen.getByLabelText(/Customer address/)).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByLabelText(/Customer address/)).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("validates a field when it loses focus", async () => {
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await user.type(screen.getByLabelText(/Customer address/), "GNOTVALID")
    expect(screen.queryByText(/valid Stellar address/)).not.toBeInTheDocument()
    await user.tab()
    expect(screen.getByText(/valid Stellar address/)).toBeInTheDocument()
  })

  it("rejects amounts with too many decimals", async () => {
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await user.type(screen.getByLabelText(/Amount/), "1.123456789")
    await user.tab()
    expect(screen.getByText("USDC supports at most 7 decimal places")).toBeInTheDocument()
  })

  it("rejects a due date in the past", async () => {
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await user.type(screen.getByLabelText(/Due date/), "2020-01-01T10:00")
    await user.tab()
    expect(screen.getByText("Due date must be in the future")).toBeInTheDocument()
  })

  it("shows the base-unit conversion hint for a valid amount", async () => {
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await user.type(screen.getByLabelText(/Amount/), "12.5")
    expect(screen.getByText(/Sent as 125000000 base units/)).toBeInTheDocument()
  })
})

describe("CreateInvoice — submission", () => {
  it("posts the invoice and shows the id with copy and QR on success", async () => {
    fetchMock.mockReturnValue(jsonResponse(201, { invoice_id: "42", status: "Pending" }))
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await fillValidForm(user)
    await user.click(screen.getByTestId("create-invoice-submit"))

    await screen.findByText("Invoice Created")
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/invoices$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({
      merchant_address: MERCHANT,
      customer_address: CUSTOMER,
      token: "USDC",
      amount: 125_000_000,
      due_date: Math.floor(new Date(TOMORROW).getTime() / 1000),
    })
    expect(screen.getByRole("button", { name: "Copy invoice ID: 42" })).toBeInTheDocument()
    expect(screen.getByTestId("invoice-qr")).toHaveTextContent("QR 42")
  })

  it("shows a loading state while submitting", async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r }))
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await fillValidForm(user)
    await user.click(screen.getByTestId("create-invoice-submit"))

    const submit = screen.getByTestId("create-invoice-submit")
    expect(submit).toBeDisabled()
    expect(submit).toHaveTextContent("Creating invoice...")
    expect(screen.getByLabelText(/Amount/)).toBeDisabled()

    resolve(new Response(JSON.stringify({ invoice_id: "7", status: "Pending" }), { status: 201 }))
    await screen.findByText("Invoice Created")
  })

  it("shows server errors and maps field details onto inputs", async () => {
    fetchMock.mockReturnValue(
      jsonResponse(400, {
        error: "amount: amount must be a positive number",
        details: [{ field: "amount", message: "amount must be a positive number" }],
      })
    )
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await fillValidForm(user)
    await user.click(screen.getByTestId("create-invoice-submit"))

    expect(await screen.findByTestId("create-invoice-server-error")).toHaveTextContent("amount must be a positive number")
    expect(screen.getByLabelText(/Amount/)).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByTestId("create-invoice-submit")).not.toBeDisabled()
  })

  it("shows a friendly message when the server is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await fillValidForm(user)
    await user.click(screen.getByTestId("create-invoice-submit"))

    expect(await screen.findByTestId("create-invoice-server-error")).toHaveTextContent(/Could not reach the server/)
  })

  it("resets to an empty form with 'Create another invoice'", async () => {
    fetchMock.mockReturnValue(jsonResponse(201, { invoice_id: "42", status: "Pending" }))
    const user = userEvent.setup()
    render(<CreateInvoice merchantAddress={MERCHANT} />)
    await fillValidForm(user)
    await user.click(screen.getByTestId("create-invoice-submit"))
    await user.click(await screen.findByText("Create another invoice"))

    await waitFor(() => expect(screen.getByLabelText(/Customer address/)).toHaveValue(""))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
