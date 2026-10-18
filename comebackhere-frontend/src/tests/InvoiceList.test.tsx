import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { InvoiceList } from "../components/InvoiceList"
import { InvoiceStatus } from "../types"
import { INVOICE_PAGE_SIZE, type InvoicePage, type InvoiceSummary } from "../utils/api"

const MERCHANT = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

function makeInvoice(id: number, status = InvoiceStatus.Pending): InvoiceSummary {
  return {
    invoice_id: String(id),
    merchant_address: MERCHANT,
    token: "USDC",
    amount: 125_000_000,
    due_date: 1_800_000_000,
    reference: id % 2 ? `order-${id}` : undefined,
    status,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
  }
}

function pageOf(data: InvoiceSummary[], page = 1, totalPages = 1, total = data.length): InvoicePage {
  return { data, page, totalPages, total, limit: INVOICE_PAGE_SIZE }
}

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

function lastQuery(): URLSearchParams {
  const calls = fetchMock.mock.calls
  const url = calls[calls.length - 1]?.[0] as string
  return new URL(url).searchParams
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("InvoiceList — states", () => {
  it("asks for a wallet and does not fetch when disconnected", () => {
    render(<InvoiceList merchantAddress={null} onOpenInvoice={vi.fn()} />)
    expect(screen.getByText(/Connect your wallet to see the invoices/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows a skeleton while loading", () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)
    expect(screen.getByLabelText("Loading invoices")).toBeInTheDocument()
  })

  it("requests invoices for the connected merchant and renders rows", async () => {
    fetchMock.mockImplementation(() => respond(pageOf([makeInvoice(1), makeInvoice(2, InvoiceStatus.Paid)])))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)

    const rows = await screen.findAllByTestId("invoice-row")
    expect(rows).toHaveLength(2)
    expect(lastQuery().get("merchant")).toBe(MERCHANT)
    expect(lastQuery().get("page")).toBe("1")
    expect(lastQuery().get("status")).toBeNull()
    expect(within(rows[0]).getByText("#1")).toBeInTheDocument()
    expect(within(rows[0]).getByText("12.5 USDC")).toBeInTheDocument()
    expect(within(rows[0]).getByText("order-1")).toBeInTheDocument()
    expect(within(rows[1]).getByLabelText("Invoice status: Paid")).toHaveClass("badge--paid")
  })

  it("shows a helpful empty state with a create shortcut", async () => {
    const onCreate = vi.fn()
    fetchMock.mockImplementation(() => respond(pageOf([], 1, 0)))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} onCreateInvoice={onCreate} />)

    expect(await screen.findByText(/not created any invoices yet/)).toBeInTheDocument()
    await userEvent.click(screen.getByText("Create your first invoice"))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it("shows API errors with a retry action", async () => {
    fetchMock
      .mockReturnValueOnce(respond({ error: "Database unavailable" }, 500))
      .mockReturnValueOnce(respond(pageOf([makeInvoice(9)])))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable")
    await userEvent.click(screen.getByText("Retry"))
    expect(await screen.findByText("#9")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("InvoiceList — filtering", () => {
  it("styles filter chips with StatusBadge classes", async () => {
    fetchMock.mockImplementation(() => respond(pageOf([])))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Refund Requested" })).toHaveClass("badge--refund-requested")
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true")
  })

  it("filters by status and resets to the first page", async () => {
    fetchMock.mockImplementation(() => respond(pageOf([makeInvoice(1)], 1, 3, 25)))
    const user = userEvent.setup()
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)
    await screen.findByText("#1")

    fetchMock.mockImplementation(() => respond(pageOf([makeInvoice(1)], 2, 3, 25)))
    await user.click(screen.getByText("Next"))
    await waitFor(() => expect(lastQuery().get("page")).toBe("2"))

    fetchMock.mockImplementation(() => respond(pageOf([makeInvoice(5, InvoiceStatus.Paid)])))
    await user.click(screen.getByRole("button", { name: "Paid" }))

    await screen.findByText("#5")
    expect(lastQuery().get("status")).toBe("Paid")
    expect(lastQuery().get("page")).toBe("1")
    expect(screen.getByRole("button", { name: "Paid" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false")
  })

  it("offers to clear the filter when a status has no invoices", async () => {
    fetchMock.mockImplementation(() => respond(pageOf([])))
    const user = userEvent.setup()
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)
    await screen.findByTestId("invoice-list-empty")

    await user.click(screen.getByRole("button", { name: "Expired" }))
    expect(await screen.findByText("No expired invoices.")).toBeInTheDocument()

    await user.click(screen.getByText("Show all invoices"))
    await waitFor(() => expect(lastQuery().get("status")).toBeNull())
  })
})

describe("InvoiceList — pagination", () => {
  it("pages forward and back using the API page cursor", async () => {
    fetchMock.mockReturnValueOnce(respond(pageOf([makeInvoice(1)], 1, 2, 12)))
    const user = userEvent.setup()
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)

    await screen.findByText("#1")
    expect(lastQuery().get("limit")).toBe(String(INVOICE_PAGE_SIZE))
    expect(screen.getByText(/Page 1 of 2/)).toHaveTextContent("12 invoices")
    expect(screen.getByText("Previous")).toBeDisabled()
    expect(screen.getByText("Next")).toBeEnabled()

    fetchMock.mockReturnValueOnce(respond(pageOf([makeInvoice(11)], 2, 2, 12)))
    await user.click(screen.getByText("Next"))
    await screen.findByText("#11")
    expect(lastQuery().get("page")).toBe("2")
    expect(screen.getByText("Next")).toBeDisabled()
    expect(screen.getByText("Previous")).toBeEnabled()

    fetchMock.mockReturnValueOnce(respond(pageOf([makeInvoice(1)], 1, 2, 12)))
    await user.click(screen.getByText("Previous"))
    await screen.findByText("#1")
    expect(lastQuery().get("page")).toBe("1")
  })
})

describe("InvoiceList — opening invoices", () => {
  it("opens the invoice when a row is clicked or activated with the keyboard", async () => {
    const onOpen = vi.fn()
    fetchMock.mockImplementation(() => respond(pageOf([makeInvoice(3), makeInvoice(4)])))
    const user = userEvent.setup()
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={onOpen} />)

    await user.click(await screen.findByLabelText("Open invoice #3"))
    expect(onOpen).toHaveBeenLastCalledWith("3")

    screen.getByLabelText("Open invoice #4").focus()
    await user.keyboard("{Enter}")
    expect(onOpen).toHaveBeenLastCalledWith("4")
  })
})

describe("InvoiceList — malformed responses", () => {
  it("treats a response without a data array as an error", async () => {
    fetchMock.mockImplementation(() => respond({ unexpected: true }))
    render(<InvoiceList merchantAddress={MERCHANT} onOpenInvoice={vi.fn()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected response from server")
  })
})
