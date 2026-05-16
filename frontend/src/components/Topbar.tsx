import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAuth } from "../auth/AuthContext";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { user, logout } = useAuth();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] bg-slate-950/90 px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="rounded-md border border-white/[0.08] bg-white/[0.03] p-1.5 text-slate-400 transition hover:border-white/20 hover:text-white"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </button>
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-techi-orange">TECHI</span>
          <span className="h-3 w-px bg-white/10" />
          <span className="text-sm font-semibold text-slate-100">Remote Dashboard</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {user && (
          <span className="hidden rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] font-semibold text-slate-300 sm:block">
            {user.username} · {user.role}
          </span>
        )}
        <span className="hidden text-[11px] font-medium text-slate-500 sm:block">Native RustDesk workflow</span>
        <span className="h-1 w-1 rounded-full bg-white/10 hidden sm:block" />
        <span className="text-[11px] font-medium text-slate-500">Developer preview</span>
        {user && (
          <button
            type="button"
            onClick={logout}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] p-1.5 text-slate-400 transition hover:border-white/20 hover:text-white"
            title="Logout"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
