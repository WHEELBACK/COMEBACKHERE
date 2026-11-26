import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { EmptyState, EmptyStateIcon } from "../components/EmptyState"

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="No invoices found" />)
    expect(screen.getByRole("status", { name: "No invoices found" })).toBeInTheDocument()
    expect(screen.getByText("No invoices found")).toBeInTheDocument()
  })

  it("renders a description when provided", () => {
    render(<EmptyState title="Empty" description="Create your first invoice." />)
    expect(screen.getByText("Create your first invoice.")).toBeInTheDocument()
  })

  it("omits the description element when not provided", () => {
    render(<EmptyState title="Empty" />)
    expect(screen.queryByText(/Create/)).not.toBeInTheDocument()
  })

  it("renders a button action and calls onClick", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<EmptyState title="Empty" action={{ label: "Create Invoice", onClick }} />)

    const button = screen.getByRole("button", { name: "Create Invoice" })
    expect(button).toBeInTheDocument()
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("renders a link action when href is provided", () => {
    render(<EmptyState title="Empty" action={{ label: "Go to docs", href: "/docs" }} />)
    const link = screen.getByRole("link", { name: "Go to docs" })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "/docs")
  })

  it("renders the icon slot when provided", () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="custom-icon" />} />)
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument()
  })

  it("renders EmptyStateIcon as an accessible SVG", () => {
    render(<EmptyStateIcon />)
    // aria-hidden means it's decorative and doesn't appear in the accessible name tree
    const svg = document.querySelector("svg")
    expect(svg).toHaveAttribute("aria-hidden", "true")
  })
})
