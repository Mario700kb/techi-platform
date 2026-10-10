import { ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { BottomNav } from "../components/BottomNav";
import { MobileTopBar } from "../components/mobile/MobileTopBar";
import { OfflineBanner } from "../components/mobile/OfflineBanner";
import { useAppData } from "../contexts/AppDataContext";
import { locateNav } from "../components/navigation";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Mobile UI 2.0 (docs/reference/MOBILE-DESIGN-SPEC.md — Navigation):
 * below md the shell is MobileTopBar + BottomNav; the slide-in sidebar is
 * replaced by the More tab. Desktop layout is unchanged.
 */

// The four tab roots show no back button; every other route is a sub-page
// reached from More. Titles come from the shared navigation config.
const TAB_ROOTS = new Set(["/", "/devices", "/alerts", "/more"]);

function mobileTitleFor(pathname: string): string {
  return locateNav(pathname).label;
}

// Device Details (MOBILE-DESIGN-SPEC.md — Device Details) renders its own
// header and sticky action bar in place of the generic MobileTopBar and
// BottomNav.
function isDeviceDetailRoute(pathname: string): boolean {
  return /^\/devices\/\d+$/.test(pathname);
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

  // Browser tab title: "Devices · TECHI Connect".
  useEffect(() => {
    const { label } = locateNav(location.pathname);
    document.title = label && label !== "TECHI Connect" ? `${label} · TECHI Connect` : "TECHI Connect";
  }, [location.pathname]);

  const isTabRoot = TAB_ROOTS.has(location.pathname);
  const isDeviceDetail = isDeviceDetailRoute(location.pathname);
  const { lastFetchTime } = useAppData();

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ background: "var(--th-bg-shell)", color: "var(--th-text-primary)" }}
    >
      <div className="h-full">
        <div
          className="grid h-full min-w-0 grid-cols-1 overflow-hidden md:grid-cols-[auto_minmax(0,1fr)]"
          style={{ background: "var(--th-bg-surface)" }}
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
            {/* Mobile top bar — Device Details renders its own header instead */}
            {!isDeviceDetail && (
              <MobileTopBar
                title={mobileTitleFor(location.pathname)}
                showBack={!isTabRoot}
                onBack={() => navigate(-1)}
              />
            )}
            <OfflineBanner lastFetchTime={lastFetchTime} />
            <main
              className={`min-w-0 flex-1 overflow-y-auto p-3 md:p-5 ${isDeviceDetail ? "pb-3 md:pb-5" : "pb-16 md:pb-5"}`}
              style={{ background: "var(--th-bg-main)" }}
            >
              {children}
            </main>
          </div>
        </div>
      </div>

      {/* Device Details renders its own StickyActionBar in this slot instead */}
      {!isDeviceDetail && <BottomNav />}
    </div>
  );
}
