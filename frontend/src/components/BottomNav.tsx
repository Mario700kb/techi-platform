import { useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Monitor, Bell, MoreHorizontal } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";
import { MORE_PATHS } from "./navigation";

/**
 * Mobile bottom navigation (docs/reference/MOBILE-DESIGN-SPEC.md): four
 * fixed tabs — Dashboard, Devices, Alerts, More. "More" replaces the
 * slide-in sidebar on mobile and stays active on its sub-pages.
 */

// Pages reachable from the More screen — the More tab stays active on them.
const MORE_SUBPATHS = MORE_PATHS;

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { alertCount } = useAppData();
  const totalAlerts = alertCount.total_open;
  const badgeText = totalAlerts > 99 ? "99+" : String(totalAlerts);

  const path = location.pathname;
  const tabs = [
    {
      label: "Dashboard",
      icon: LayoutDashboard,
      to: "/",
      active: path === "/",
      badge: 0,
    },
    {
      label: "Devices",
      icon: Monitor,
      to: "/devices",
      active: path.startsWith("/devices"),
      badge: 0,
    },
    {
      label: "Alerts",
      icon: Bell,
      to: "/alerts",
      active: path === "/alerts",
      badge: totalAlerts,
    },
    {
      label: "More",
      icon: MoreHorizontal,
      to: "/more",
      active: MORE_SUBPATHS.some((p) => path === p || path.startsWith(p + "/")),
      badge: 0,
    },
  ];

  return (
    <nav aria-label="Primary" className="th-mnav md:hidden">
      {tabs.map(({ label, icon: Icon, to, active, badge }) => (
        <button
          key={label}
          type="button"
          onClick={() => navigate(to)}
          aria-current={active ? "page" : undefined}
          aria-label={badge > 0 ? `${label}, ${totalAlerts} open` : label}
          className="th-mnav-btn m-bottomnav-btn"
        >
          <span className="th-mnav-icon">
            <Icon className="h-5 w-5" strokeWidth={active ? 2.1 : 1.8} />
            {badge > 0 && <span aria-hidden="true" className="th-mnav-badge">{badgeText}</span>}
          </span>
          <span className="th-mnav-label m-bottomnav-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
