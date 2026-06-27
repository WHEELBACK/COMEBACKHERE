import { Navigate, Route, Routes } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";
import SignerManagement from "./components/SignerManagement/SignerManagement";
import ABIExplorer from "./components/ABIExplorer";
import { ThemeProvider, useTheme } from "./theme";

function InvoicesPage() {
  return <p>Invoices list will appear here.</p>;
}

function SettlementsPage() {
  return <SettlementProposalForm />;
}

function DisputesPage() {
  return <DisputeVotingPanel />;
}

function SignersPage() {
  return <SignerManagement />;
}

function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <section className="settings-panel">
      <div>
        <h3 className="settings-panel__title">Appearance</h3>
        <p className="settings-panel__description">
          Current theme: {theme}. Your choice is remembered on this device.
        </p>
      </div>
      <button
        type="button"
        className="theme-toggle theme-toggle--wide"
        onClick={toggleTheme}
        aria-label={`Switch to ${nextTheme} theme`}
      >
        <span>Use {nextTheme} theme</span>
      </button>
    </section>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<Navigate to="/invoices" replace />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="settlements" element={<SettlementsPage />} />
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="signers" element={<SignersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="abi" element={<ABIExplorer />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppRoutes />
    </ThemeProvider>
  );
}
