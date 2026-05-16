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

  const handleSidebarCollapsedChange = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    window.localStorage.setItem("techi.sidebar.collapsed", String(collapsed));
  };

  return (
    <div className="min-h-screen bg-[#0a0c12] text-white">
      <div className="p-2 lg:p-4">
        <div className="grid min-h-[calc(100vh-1rem)] grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-white/[0.12] bg-slate-950/85 shadow-soft lg:min-h-[calc(100vh-2rem)]">
          <Sidebar collapsed={sidebarCollapsed} onCollapsedChange={handleSidebarCollapsedChange} />
          <div className="flex min-w-0 flex-col">
            <Topbar collapsed={sidebarCollapsed} onToggleSidebar={() => handleSidebarCollapsedChange(!sidebarCollapsed)} />
            <main className="min-w-0 flex-1 bg-[#080d18]/95 p-3 backdrop-blur-sm lg:p-4">
              {children}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
