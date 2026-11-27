import { describe, it, expect } from "vitest"
import { statusBadgeClass, statusLabel } from "../utils/invoiceStatus"
import { InvoiceStatus } from "../types"

describe("statusBadgeClass", () => {
  it("returns the correct CSS class for each known status", () => {
    expect(statusBadgeClass(InvoiceStatus.Pending)).toBe("badge badge--pending")
    expect(statusBadgeClass(InvoiceStatus.Paid)).toBe("badge badge--paid")
    expect(statusBadgeClass(InvoiceStatus.Expired)).toBe("badge badge--expired")
    expect(statusBadgeClass(InvoiceStatus.Cancelled)).toBe("badge badge--cancelled")
    expect(statusBadgeClass(InvoiceStatus.RefundRequested)).toBe("badge badge--refund-requested")
    expect(statusBadgeClass(InvoiceStatus.Released)).toBe("badge badge--released")
    expect(statusBadgeClass(InvoiceStatus.OnHold)).toBe("badge badge--on-hold")
  })

  it("falls back to 'badge' for unknown statuses", () => {
    expect(statusBadgeClass("Unknown" as InvoiceStatus)).toBe("badge")
  })
})

describe("statusLabel", () => {
  it("returns human-readable labels", () => {
    expect(statusLabel(InvoiceStatus.Pending)).toBe("Pending")
    expect(statusLabel(InvoiceStatus.Paid)).toBe("Paid")
    expect(statusLabel(InvoiceStatus.Expired)).toBe("Expired")
    expect(statusLabel(InvoiceStatus.Cancelled)).toBe("Cancelled")
    expect(statusLabel(InvoiceStatus.RefundRequested)).toBe("Refund Requested")
    expect(statusLabel(InvoiceStatus.Released)).toBe("Released")
    expect(statusLabel(InvoiceStatus.OnHold)).toBe("On Hold")
  })

  it("returns the raw status string for unknown values", () => {
    expect(statusLabel("SomeNewStatus" as InvoiceStatus)).toBe("SomeNewStatus")
  })
})
