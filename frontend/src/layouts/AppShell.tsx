import { ReactNode, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("techi.sidebar.collapsed") !== "false";
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const handleSidebarCollapsedChange = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    window.localStorage.setItem("techi.sidebar.collapsed", String(collapsed));
  };

  const handleTopbarToggle = () => {
    if (window.innerWidth < 640) {
      setMobileSidebarOpen((prev) => !prev);
    } else {
      handleSidebarCollapsedChange(!sidebarCollapsed);
    }
  };

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ background: "var(--th-bg-shell)", color: "var(--th-text-primary)" }}
    >
      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 sm:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 sm:hidden ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ transition: "transform 380ms cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        <Sidebar
          collapsed={false}
          onCollapsedChange={() => setMobileSidebarOpen(false)}
          onNavigate={() => setMobileSidebarOpen(false)}
        />
      </div>

      <div className="h-full p-2 lg:p-3">
        <div
          className="grid h-full min-w-0 grid-cols-1 overflow-hidden rounded-xl shadow-soft sm:grid-cols-[auto_minmax(0,1fr)]"
          style={{
            border: "1px solid var(--th-shell-border)",
            background: "var(--th-bg-surface)",
          }}
        >
          {/* Desktop sidebar */}
          <div className="hidden min-w-0 sm:block">
            <Sidebar collapsed={sidebarCollapsed} onCollapsedChange={handleSidebarCollapsedChange} />
          </div>
          <div className="flex h-full min-w-0 flex-col overflow-hidden">
            <Topbar
              collapsed={sidebarCollapsed}
              onToggleSidebar={handleTopbarToggle}
            />
            <main
              className="min-w-0 flex-1 overflow-y-auto p-3 lg:p-4"
              style={{ background: "var(--th-bg-main)" }}
            >
              {children}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
