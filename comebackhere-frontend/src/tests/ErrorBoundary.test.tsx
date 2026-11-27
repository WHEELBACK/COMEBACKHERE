import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ErrorBoundary } from "../components/ErrorBoundary"

// Suppress console.error from React during error boundary tests
const originalConsoleError = console.error
beforeEach(() => {
  console.error = vi.fn()
})
afterEach(() => {
  console.error = originalConsoleError
})

function ThrowingComponent({ shouldThrow = false }: { shouldThrow?: boolean }) {
  if (shouldThrow) throw new Error("Test render error")
  return <div>Works fine</div>
}

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    )
    expect(screen.getByText("Works fine")).toBeInTheDocument()
  })

  it("renders the fallback UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow />
      </ErrorBoundary>
    )
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(screen.getByText("Test render error")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
  })

  it("renders a custom fallback title when provided", () => {
    render(
      <ErrorBoundary fallbackTitle="Payment failed to load">
        <ThrowingComponent shouldThrow />
      </ErrorBoundary>
    )
    expect(screen.getByText("Payment failed to load")).toBeInTheDocument()
  })

  it("resets error state when Try Again is clicked", async () => {
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow />
      </ErrorBoundary>
    )

    // Error UI is showing
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()

    // Click retry; boundary clears error and re-renders children (which still throw in this test)
    await user.click(screen.getByRole("button", { name: /try again/i }))
    // After reset the boundary tries to render children again — since they still throw,
    // the boundary catches again and shows the fallback.
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })

  it("does not show the fallback when no error occurs after retry", async () => {
    const user = userEvent.setup()
    let shouldThrow = true

    function TogglableThrow() {
      if (shouldThrow) throw new Error("boom")
      return <div>Recovered</div>
    }

    render(
      <ErrorBoundary>
        <TogglableThrow />
      </ErrorBoundary>
    )

    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    shouldThrow = false
    await user.click(screen.getByRole("button", { name: /try again/i }))
    expect(screen.getByText("Recovered")).toBeInTheDocument()
  })
})
