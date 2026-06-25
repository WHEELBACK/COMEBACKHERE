import { Navigate, Route, Routes } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";

function InvoicesPage() {
  return <p>Invoices list will appear here.</p>;
}

function SettlementsPage() {
  return <SettlementProposalForm />;
}

function DisputesPage() {
  return <DisputeVotingPanel />;
}

function SettingsPage() {
  return <p>Settings will appear here.</p>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<Navigate to="/invoices" replace />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="settlements" element={<SettlementsPage />} />
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="abi" element={<ABIExplorer />} />
      </Route>
    </Routes>
  );
}
