import { ReactNode } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-techi-dark text-white">
      <div className="grid min-h-screen grid-cols-[260px_1fr] gap-4 px-4 py-4 lg:px-8">
        <Sidebar />
        <div className="flex flex-col gap-4">
          <Topbar />
          <main className="rounded-3xl bg-slate-950/90 p-6 shadow-soft ring-1 ring-white/10 backdrop-blur-sm">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
