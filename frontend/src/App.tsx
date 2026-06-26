import { Navigate, Route, Routes } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";
import SignerManagement from "./components/SignerManagement/SignerManagement";
import ABIExplorer from "./components/ABIExplorer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./components/ErrorBoundary.css";

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
  return (
    <ErrorBoundary fallbackTitle="Failed to load settings">
      <p>Settings will appear here.</p>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<Navigate to="/invoices" replace />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="settlements" element={<SettlementsPage />} />
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="signers" element={<SignersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="abi" element={<ErrorBoundary fallbackTitle="Failed to load ABI explorer"><ABIExplorer /></ErrorBoundary>} />
      </Route>
    </Routes>
  );
}
