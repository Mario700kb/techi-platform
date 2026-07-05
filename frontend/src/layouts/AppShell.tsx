import { ReactNode, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { BottomNav } from "../components/BottomNav";
import { MobileTopBar } from "../components/mobile/MobileTopBar";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Mobile UI 2.0 (docs/reference/MOBILE-DESIGN-SPEC.md — Navigation):
 * below md the shell is MobileTopBar + BottomNav; the slide-in sidebar is
 * replaced by the More tab. Desktop layout is unchanged.
 */

// Screen titles for the mobile top bar. The four tab roots show no back
// button; every other route is a sub-page reached from More.
const MOBILE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/devices": "Devices",
  "/alerts": "Alerts",
  "/more": "More",
  "/settings": "Settings",
  "/clients": "Clients",
  "/remote-support": "Remote Support",
  "/audit": "Audit Log",
  "/deployment": "Deployment",
  "/enrollment-bootstrap": "Enrollment",
  "/agent-packages": "Packages",
  "/inventory": "Inventory",
  "/operators": "Operators",
  "/teams": "Teams",
  "/agent-config": "Agent Config",
};
const TAB_ROOTS = new Set(["/", "/devices", "/alerts", "/more"]);

function mobileTitleFor(pathname: string): string {
  if (MOBILE_TITLES[pathname]) return MOBILE_TITLES[pathname];
  const base = "/" + pathname.split("/")[1];
  return MOBILE_TITLES[base] ?? "TECHI";
}

export default function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("techi.sidebar.collapsed") !== "false";
  });

  const handleSidebarCollapsedChange = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    window.localStorage.setItem("techi.sidebar.collapsed", String(collapsed));
  };

  const isTabRoot = TAB_ROOTS.has(location.pathname);

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ background: "var(--th-bg-shell)", color: "var(--th-text-primary)" }}
    >
      <div className="h-full p-2 lg:p-3">
        <div
          className="grid h-full min-w-0 grid-cols-1 overflow-hidden rounded-xl shadow-soft md:grid-cols-[auto_minmax(0,1fr)]"
          style={{
            border: "1px solid var(--th-shell-border)",
            background: "var(--th-bg-surface)",
          }}
        >
          {/* Desktop sidebar — unchanged */}
          <div className="hidden min-w-0 md:block">
            <Sidebar collapsed={sidebarCollapsed} onCollapsedChange={handleSidebarCollapsedChange} />
          </div>
          <div className="flex h-full min-w-0 flex-col overflow-hidden">
            {/* Desktop top bar — unchanged, hidden on mobile */}
            <div className="hidden md:block">
              <Topbar
                collapsed={sidebarCollapsed}
                onToggleSidebar={() => handleSidebarCollapsedChange(!sidebarCollapsed)}
              />
            </div>
            {/* Mobile top bar */}
            <MobileTopBar
              title={mobileTitleFor(location.pathname)}
              showBack={!isTabRoot}
              onBack={() => navigate(-1)}
            />
            <main
              className="min-w-0 flex-1 overflow-y-auto p-3 pb-16 md:pb-4 lg:p-4"
              style={{ background: "var(--th-bg-main)" }}
            >
              {children}
            </main>
          </div>
        </div>
      </div>

      <BottomNav />
    </div>
  );
}
