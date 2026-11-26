import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ToastProvider, ToastContext } from "../components/Toast"
import { useContext } from "react"

function ToastTrigger({
  type,
  message,
  duration,
}: {
  type: "success" | "error" | "info"
  message: string
  duration?: number
}) {
  const ctx = useContext(ToastContext)!
  return (
    <button onClick={() => ctx.addToast(type, message, duration)}>
      Add {type}
    </button>
  )
}

describe("ToastProvider — rendering", () => {
  it("renders children without any toasts initially", () => {
    render(
      <ToastProvider>
        <span>child</span>
      </ToastProvider>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("ToastProvider — adding toasts", () => {
  it("shows a success toast when addToast is called", async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastTrigger type="success" message="Saved!" duration={30000} />
      </ToastProvider>
    )
    await user.click(screen.getByRole("button", { name: /add success/i }))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("Saved!")).toBeInTheDocument()
  })

  it("shows an error toast with the error icon", async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastTrigger type="error" message="Something broke" duration={30000} />
      </ToastProvider>
    )
    await user.click(screen.getByRole("button", { name: /add error/i }))
    expect(screen.getByText("Something broke")).toBeInTheDocument()
  })

  it("substitutes a fallback message when addToast is called with an empty string", async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastTrigger type="error" message="" duration={30000} />
      </ToastProvider>
    )
    await user.click(screen.getByRole("button", { name: /add error/i }))
    expect(
      screen.getByText(/something went wrong\. please try again\./i)
    ).toBeInTheDocument()
  })

  it("manually dismisses a toast when the dismiss button is clicked", async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastTrigger type="success" message="Dismiss me" duration={30000} />
      </ToastProvider>
    )
    await user.click(screen.getByRole("button", { name: /add success/i }))
    expect(screen.getByText("Dismiss me")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(screen.queryByText("Dismiss me")).not.toBeInTheDocument()
  })
})

describe("ToastProvider — auto-dismiss with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("auto-dismisses the toast after the configured duration", () => {
    render(
      <ToastProvider>
        <ToastTrigger type="info" message="Info" duration={3000} />
      </ToastProvider>
    )

    act(() => {
      screen.getByRole("button", { name: /add info/i }).click()
    })
    expect(screen.getByText("Info")).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3100)
    })
    expect(screen.queryByText("Info")).not.toBeInTheDocument()
  })
})
