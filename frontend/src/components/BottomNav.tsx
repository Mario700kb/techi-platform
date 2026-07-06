import { useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Monitor, Bell, MoreHorizontal } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";

/**
 * Mobile UI 2.0 bottom navigation (docs/reference/MOBILE-DESIGN-SPEC.md):
 * 4 fixed tabs — Dashboard, Devices, Alerts, More. "More" replaces the old
 * slide-in sidebar on mobile and stays active on its sub-pages.
 */

// Pages reachable from the More screen — the More tab stays active on them.
const MORE_SUBPATHS = [
  "/more",
  "/settings",
  "/clients",
  "/remote-support",
  "/audit",
  "/deployment",
  "/enrollment-bootstrap",
  "/agent-packages",
  "/inventory",
  "/operators",
  "/teams",
  "/agent-config",
];

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
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: "var(--th-bg-sidebar)",
        borderTop: "1px solid var(--th-border-subtle)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-stretch">
        {tabs.map(({ label, icon: Icon, to, active, badge }) => (
          <button
            key={label}
            type="button"
            onClick={() => navigate(to)}
            aria-current={active ? "page" : undefined}
            aria-label={
              badge > 0 ? `${label}, ${totalAlerts} open` : label
            }
            className="m-bottomnav-btn relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 py-2.5 transition-colors"
            style={{
              color: active ? "var(--th-accent)" : "var(--th-text-muted)",
            }}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute top-0 rounded-full"
                style={{
                  left: "26%",
                  right: "26%",
                  height: 2.5,
                  background: "var(--th-accent)",
                }}
              />
            )}
            <span className="relative">
              <Icon className="h-[21px] w-[21px]" strokeWidth={1.8} />
              {badge > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-3 -top-2 flex h-4 min-w-[20px] items-center justify-center rounded-full px-1 text-[9.5px] font-extrabold leading-none"
                  style={{ background: "var(--danger)", color: "#fff" }}
                >
                  {badgeText}
                </span>
              )}
            </span>
            <span className="m-bottomnav-label text-[11px] font-bold">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
