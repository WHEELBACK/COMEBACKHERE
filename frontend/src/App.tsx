import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";
import SignerManagement from "./components/SignerManagement/SignerManagement";
import ABIExplorer from "./components/ABIExplorer";
import InvoiceSearchFilter from "./components/InvoiceSearchFilter";
import ThresholdConfig from "./components/ThresholdConfig/ThresholdConfig";
import { ThemeProvider, useTheme } from "./theme";
import { Invoice } from "./types";

// Placeholder data — replace with real API hook when the invoices endpoint is ready
const MOCK_INVOICES: Invoice[] = [];

function InvoicesPage() {
  return (
    <section>
      <h3 style={{ marginBottom: 16 }}>Invoices</h3>
      <InvoiceSearchFilter invoices={MOCK_INVOICES} />
    </section>
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
      <ThresholdConfig />
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
