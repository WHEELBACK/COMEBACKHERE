import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, afterEach } from "vitest"
import { CopyableText } from "../components/CopyableText"

afterEach(() => {
  vi.restoreAllMocks()
  window.getSelection()?.removeAllRanges()
})

describe("CopyableText", () => {
  it("selects the text and announces confirmation when Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })

    render(<CopyableText text="fallback-value" label="Copy value" />)
    await userEvent.click(screen.getByRole("button", { name: /copy value/i }))

    expect(window.getSelection()?.toString()).toBe("fallback-value")
    expect(screen.getByRole("status")).toHaveTextContent("Copied!")
  })

  it("uses the Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    render(<CopyableText text="clipboard-value" />)
    await userEvent.click(screen.getByRole("button", { name: /copy/i }))

    expect(writeText).toHaveBeenCalledWith("clipboard-value")
  })
})
