import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import StatsCard from "./StatsCard";

describe("StatsCard", () => {
  // -------------------------------------------------------------------------
  // Normal rendering
  // -------------------------------------------------------------------------
  describe("normal value rendering", () => {
    it("renders the title", () => {
      render(<StatsCard title="Total Settlements" value="42" />);
      expect(screen.getByText("Total Settlements")).toBeInTheDocument();
    });

    it("renders the value when provided", () => {
      render(<StatsCard title="Total Settlements" value="42" />);
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("does not render a skeleton when value is a non-empty string", () => {
      render(<StatsCard title="Total Settlements" value="42" />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("renders value '0' without a skeleton (falsy-but-valid value)", () => {
      render(<StatsCard title="Disputes" value="0" />);
      expect(screen.getByText("0")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Loading skeleton for null / undefined
  // -------------------------------------------------------------------------
  describe("loading skeleton state", () => {
    it("renders a loading skeleton when value is null", () => {
      render(<StatsCard title="Total Settlements" value={null} />);
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("renders a loading skeleton when value is undefined", () => {
      render(<StatsCard title="Total Settlements" value={undefined} />);
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("does not render the value paragraph when value is null", () => {
      render(<StatsCard title="Total Settlements" value={null} />);
      // The value paragraph should be absent; only the skeleton status element.
      const valueEl = screen.queryByText(/^\d/);
      expect(valueEl).not.toBeInTheDocument();
    });

    it("skeleton has an accessible label that includes the card title", () => {
      render(<StatsCard title="Active Disputes" value={null} />);
      // The Skeleton component renders with aria-label on the status div.
      expect(screen.getByRole("status", { name: /Active Disputes/i })).toBeInTheDocument();
    });

    it("still renders the card title while the value is loading", () => {
      render(<StatsCard title="Pending Approvals" value={null} />);
      expect(screen.getByText("Pending Approvals")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Variant classes
  // -------------------------------------------------------------------------
  describe("variant prop", () => {
    it("applies the default variant class by default", () => {
      const { container } = render(<StatsCard title="T" value="1" />);
      expect(container.firstChild).toHaveClass("stats-card--default");
    });

    it("applies the success variant class", () => {
      const { container } = render(<StatsCard title="T" value="1" variant="success" />);
      expect(container.firstChild).toHaveClass("stats-card--success");
    });

    it("applies the warning variant class", () => {
      const { container } = render(<StatsCard title="T" value="1" variant="warning" />);
      expect(container.firstChild).toHaveClass("stats-card--warning");
    });

    it("applies the danger variant class", () => {
      const { container } = render(<StatsCard title="T" value="1" variant="danger" />);
      expect(container.firstChild).toHaveClass("stats-card--danger");
    });

    it("applies the correct variant class even when value is null (loading state)", () => {
      const { container } = render(<StatsCard title="T" value={null} variant="danger" />);
      expect(container.firstChild).toHaveClass("stats-card--danger");
    });
  });
});
