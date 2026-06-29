import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import StatsCard from "./StatsCard";
import { DashboardStatsSkeleton } from "../Skeleton";
import { useTheme } from "../../theme";
import "./DashboardLayout.css";

const stats = [
  { title: "Pending Invoices", value: "12", variant: "warning" as const },
  { title: "Total Settled (USD)", value: "$84,250.00", variant: "success" as const },
  { title: "Open Disputes", value: "3", variant: "danger" as const },
];

export default function DashboardLayout() {
  const { theme, toggleTheme } = useTheme();
  const [statsLoading, setStatsLoading] = useState(true);
  const nextTheme = theme === "dark" ? "light" : "dark";

  useEffect(() => {
    const t = setTimeout(() => setStatsLoading(false), 1000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="dashboard">
      <Sidebar />
      <main className="dashboard-main">
        <header className="dashboard-header">
          <h2 className="dashboard-heading">Overview</h2>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${nextTheme} theme`}
          >
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </header>
        <section className="stats-grid">
          {statsLoading ? (
            <DashboardStatsSkeleton />
          ) : (
            stats.map((stat) => (
              <StatsCard
                key={stat.title}
                title={stat.title}
                value={stat.value}
                variant={stat.variant}
              />
            ))
          )}
        </section>
        <section className="dashboard-content">
          <Outlet />
        </section>
      </main>
    </div>
  );
}
