import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import StatsCard from "./StatsCard";
import "./DashboardLayout.css";

const stats = [
  { title: "Pending Invoices", value: "12", variant: "warning" as const },
  { title: "Total Settled (USD)", value: "$84,250.00", variant: "success" as const },
  { title: "Open Disputes", value: "3", variant: "danger" as const },
];

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main className="dashboard-main" role="main">
        <header className="dashboard-header" role="banner">
          <h2 className="dashboard-heading">Overview</h2>
        </header>
        <section className="stats-grid" aria-label="Dashboard statistics">
          {stats.map((stat) => (
            <StatsCard
              key={stat.title}
              title={stat.title}
              value={stat.value}
              variant={stat.variant}
            />
          ))}
        </section>
        <section className="dashboard-content">
          <Outlet />
        </section>
      </main>
    </div>
  );
}
