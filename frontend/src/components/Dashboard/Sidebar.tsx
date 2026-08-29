import { NavLink } from "react-router-dom";
import { useSigners } from "../../hooks/useSigners";
import "./Sidebar.css";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** When true, the link is only shown to wallets that are registered signers. */
  adminOnly?: boolean;
}

const links: NavItem[] = [
  { to: "/invoices", label: "Invoices", icon: "receipt" },
  { to: "/settlements", label: "Settlements", icon: "account_balance" },
  { to: "/on-hold", label: "On-Hold", icon: "hold" },
  { to: "/disputes", label: "Disputes", icon: "gavel" },
  // Admin-only: visible only to registered signers / protocol operators
  { to: "/treasury", label: "Treasury", icon: "treasury", adminOnly: true },
  { to: "/signers", label: "Signers", icon: "signers", adminOnly: true },
  { to: "/settings", label: "Settings", icon: "settings", adminOnly: true },
];

const iconMap: Record<string, string> = {
  receipt: "\u{1F4CB}",
  account_balance: "\u{1F3E6}",
  hold: "\u{23F8}\u{FE0F}",
  treasury: "\u{1F4B0}",
  gavel: "\u{2696}\u{FE0F}",
  signers: "\u{1F511}",
  settings: "\u{2699}\u{FE0F}",
};

interface SidebarProps {
  /**
   * The Stellar public key of the currently-connected wallet.
   * When undefined/null the component treats the visitor as unauthenticated
   * and hides all admin-only links.
   */
  connectedAddress?: string | null;
}

export default function Sidebar({ connectedAddress }: SidebarProps) {
  const { signers, loading: signersLoading } = useSigners();

  /**
   * Determine whether the connected wallet is a registered signer.
   *
   * We resolve this from the treasury signer list fetched via useSigners.
   * While the signer list is still loading we conservatively hide admin links
   * (fail-closed) to prevent a momentary flash of privileged navigation items
   * to non-admin users.
   */
  const isAdmin =
    !signersLoading &&
    !!connectedAddress &&
    signers.some(
      (s) => s.address.toLowerCase() === connectedAddress.toLowerCase(),
    );

  const visibleLinks = links.filter((link) => !link.adminOnly || isAdmin);

  return (
    <aside className="sidebar" role="complementary" aria-label="Sidebar navigation">
      <div className="sidebar-header">
        <h1 className="sidebar-logo">COMEBACKHERE</h1>
        <p className="sidebar-subtitle">Merchant Dashboard</p>
      </div>
      <nav className="sidebar-nav" aria-label="Dashboard navigation">
        {visibleLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `sidebar-link${isActive ? " sidebar-link--active" : ""}`
            }
          >
            <span className="sidebar-link-icon">{iconMap[link.icon]}</span>
            <span className="sidebar-link-label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <p className="sidebar-version">v1.0.0</p>
      </div>
    </aside>
  );
}
