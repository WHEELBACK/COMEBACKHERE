/**
 * Invoice export with date range filtering tests.
 *
 * Verify that the export endpoint supports:
 * - from_date and to_date query parameters (Unix timestamps in seconds)
 * - date_field parameter to select which field to filter (created_at, due_date, updated_at)
 * - Proper date range logic in filenames
 */

import { describe, it, expect } from "vitest"
import { parseListFilters, buildListFilter } from "../routes/invoices.js"

describe("Invoice Export Date Range Filtering", () => {
  describe("parseListFilters with date ranges", () => {
    it("parses from_date and to_date as Unix timestamps", () => {
      const query = {
        from_date: "1700000000",
        to_date: "1700086400",
      }

      const filters = parseListFilters(query)

      expect(filters.fromDate).toBe(1700000000)
      expect(filters.toDate).toBe(1700086400)
      expect(filters.dateField).toBe("created_at") // default
    })

    it("parses date_field parameter", () => {
      const query = {
        from_date: "1700000000",
        date_field: "due_date",
      }

      const filters = parseListFilters(query)

      expect(filters.dateField).toBe("due_date")
    })

    it("ignores invalid date_field values", () => {
      const query = {
        from_date: "1700000000",
        date_field: "invalid_field",
      }

      const filters = parseListFilters(query)

      expect(filters.dateField).toBe("created_at") // falls back to default
    })

    it("rejects non-numeric date values", () => {
      const query = {
        from_date: "not-a-number",
        to_date: "1700086400",
      }

      const filters = parseListFilters(query)

      expect(filters.fromDate).toBeUndefined()
      expect(filters.toDate).toBe(1700086400)
    })

    it("throws error if from_date is after to_date", () => {
      const query = {
        from_date: "1700086400",
        to_date: "1700000000",
      }

      expect(() => parseListFilters(query)).toThrow("from_date must be before to_date")
    })

    it("handles missing date filters", () => {
      const query = { status: "Paid" }

      const filters = parseListFilters(query)

      expect(filters.fromDate).toBeUndefined()
      expect(filters.toDate).toBeUndefined()
      expect(filters.dateField).toBeUndefined()
    })

    it("allows only from_date without to_date", () => {
      const query = {
        from_date: "1700000000",
        date_field: "updated_at",
      }

      const filters = parseListFilters(query)

      expect(filters.fromDate).toBe(1700000000)
      expect(filters.toDate).toBeUndefined()
      expect(filters.dateField).toBe("updated_at")
    })

    it("allows only to_date without from_date", () => {
      const query = {
        to_date: "1700086400",
        date_field: "updated_at",
      }

      const filters = parseListFilters(query)

      expect(filters.fromDate).toBeUndefined()
      expect(filters.toDate).toBe(1700086400)
      expect(filters.dateField).toBe("updated_at")
    })

    it("combines status, merchant, and date filters", () => {
      const query = {
        status: "Paid",
        merchant: "G123MERCHANT",
        from_date: "1700000000",
        to_date: "1700086400",
        date_field: "created_at",
      }

      const filters = parseListFilters(query)

      expect(filters.status).toBe("Paid")
      expect(filters.merchant).toBe("G123MERCHANT")
      expect(filters.fromDate).toBe(1700000000)
      expect(filters.toDate).toBe(1700086400)
      expect(filters.dateField).toBe("created_at")
    })
  })

  describe("buildListFilter with date ranges", () => {
    it("builds MongoDB filter with $gte for from_date", () => {
      const filters = {
        fromDate: 1700000000,
        dateField: "created_at" as const,
      }

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.created_at).toEqual({
        $gte: 1700000000 * 1000, // converted to milliseconds
      })
    })

    it("builds MongoDB filter with $lt for to_date (end of day)", () => {
      const filters = {
        toDate: 1700000000,
        dateField: "created_at" as const,
      }

      const mongoFilter = buildListFilter(filters)

      // $lt includes the end of the day (86400 seconds = 1 day)
      expect(mongoFilter.created_at).toEqual({
        $lt: (1700000000 + 86_400) * 1000,
      })
    })

    it("builds MongoDB filter with both $gte and $lt for date range", () => {
      const filters = {
        fromDate: 1700000000,
        toDate: 1700086400,
        dateField: "due_date" as const,
      }

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.due_date).toEqual({
        $gte: 1700000000 * 1000,
        $lt: (1700086400 + 86_400) * 1000,
      })
    })

    it("filters on different date fields", () => {
      const filters = {
        fromDate: 1700000000,
        dateField: "updated_at" as const,
      }

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.updated_at).toBeDefined()
      expect(mongoFilter.created_at).toBeUndefined()
    })

    it("combines all filters including date range", () => {
      const filters = {
        status: "Paid" as const,
        merchant: "G123MERCHANT",
        fromDate: 1700000000,
        toDate: 1700086400,
        dateField: "created_at" as const,
      }

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.status).toBe("Paid")
      expect(mongoFilter.merchant_address).toBe("G123MERCHANT")
      expect(mongoFilter.created_at).toEqual({
        $gte: 1700000000 * 1000,
        $lt: (1700086400 + 86_400) * 1000,
      })
    })

    it("does not add date filter if dateField is missing", () => {
      const filters = {
        fromDate: 1700000000,
        // dateField is undefined
      }

      const mongoFilter = buildListFilter(filters as any)

      expect(Object.keys(mongoFilter).length).toBe(0)
    })

    it("does not add date filter if both from/to dates are missing", () => {
      const filters = {
        dateField: "created_at" as const,
        // neither fromDate nor toDate
      }

      const mongoFilter = buildListFilter(filters as any)

      expect(Object.keys(mongoFilter).length).toBe(0)
    })
  })

  describe("Example export scenarios", () => {
    it("exports invoices created on a specific day", () => {
      const dayStart = 1700000000 // Nov 15, 2023
      const dayEnd = 1700000000 // Same day

      const filters = parseListFilters({
        from_date: String(dayStart),
        to_date: String(dayEnd),
        date_field: "created_at",
      })

      const mongoFilter = buildListFilter(filters)

      // Should include all invoices created on that day
      expect(mongoFilter.created_at).toEqual({
        $gte: dayStart * 1000,
        $lt: (dayEnd + 86_400) * 1000,
      })
    })

    it("exports invoices with due dates in a range", () => {
      const rangeStart = 1700000000 // Nov 15, 2023
      const rangeEnd = 1700172800 // Nov 17, 2023

      const filters = parseListFilters({
        from_date: String(rangeStart),
        to_date: String(rangeEnd),
        date_field: "due_date",
      })

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.due_date).toEqual({
        $gte: rangeStart * 1000,
        $lt: (rangeEnd + 86_400) * 1000,
      })
    })

    it("exports recent invoices (since date)", () => {
      const sinceDate = 1700000000

      const filters = parseListFilters({
        from_date: String(sinceDate),
        date_field: "updated_at",
      })

      const mongoFilter = buildListFilter(filters)

      expect(mongoFilter.updated_at).toEqual({
        $gte: sinceDate * 1000,
      })
    })
  })
})
