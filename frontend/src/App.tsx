import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";
import SignerManagement from "./components/SignerManagement/SignerManagement";
import ABIExplorer from "./components/ABIExplorer";
import GraceWindowSettings from "./components/GraceWindowSettings/GraceWindowSettings";
import { ThemeProvider, useTheme } from "./theme";

function InvoicesPage() {
  return (
    <ErrorBoundary fallbackTitle="Failed to load invoices">
      <p>Invoices list will appear here.</p>
    </ErrorBoundary>
  );
}

function SettlementsPage() {
  return (
    <ErrorBoundary fallbackTitle="Failed to load settlements">
      <SettlementProposalForm />
    </ErrorBoundary>
  );
}

function DisputesPage() {
  return (
    <ErrorBoundary fallbackTitle="Failed to load disputes">
      <DisputeVotingPanel />
    </ErrorBoundary>
  );
}

function SignersPage() {
  return (
    <ErrorBoundary fallbackTitle="Failed to load signer management">
      <SignerManagement />
    </ErrorBoundary>
  );
}

function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <>
      <GraceWindowSettings />
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
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="onboarding" element={<OnboardingPage />} />
      <Route element={<DashboardLayout />}>
        <Route index element={<Navigate to="/invoices" replace />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="settlements" element={<SettlementsPage />} />
        <Route path="settlements/:id" element={<SettlementDetailPage />} />
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="signers" element={<SignersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="abi" element={<ErrorBoundary fallbackTitle="Failed to load ABI explorer"><ABIExplorer /></ErrorBoundary>} />
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
