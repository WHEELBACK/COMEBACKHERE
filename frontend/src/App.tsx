import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./components/Dashboard/DashboardLayout";
import SettlementProposalForm from "./components/SettlementProposal/SettlementProposalForm";
import DisputeVotingPanel from "./components/DisputeVoting/DisputeVotingPanel";
import SignerManagement from "./components/SignerManagement/SignerManagement";
import ABIExplorer from "./components/ABIExplorer";
import OnboardingWizard from "./components/OnboardingWizard/OnboardingWizard";

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
  return <p>Settings will appear here.</p>;
}

function OnboardingPage() {
  const navigate = useNavigate();
  return <OnboardingWizard onComplete={() => navigate("/invoices")} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="onboarding" element={<OnboardingPage />} />
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
