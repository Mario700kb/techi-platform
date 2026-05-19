import { LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();

  return (
    <div
      className="flex min-w-0 items-center justify-between gap-3 border-b px-3 py-2"
      style={{
        background: "var(--th-bg-topbar)",
        borderBottomColor: "var(--th-border-default)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="rounded-md border p-1.5 transition"
          style={{
            borderColor: "var(--th-border-default)",
            background: "var(--th-bg-surface)",
            color: "var(--th-text-muted)",
          }}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex-none text-[10px] font-semibold uppercase tracking-[0.22em] text-techi-orange">TECHI</span>
          <span className="h-3 w-px" style={{ background: "var(--th-border-default)" }} />
          <span className="truncate text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>Remote Dashboard</span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        {user && (
          <span
            className="hidden rounded-md border px-2 py-1 text-[11px] font-semibold sm:block"
            style={{
              borderColor: "var(--th-border-default)",
              background: "var(--th-bg-surface)",
              color: "var(--th-text-secondary)",
            }}
          >
            {user.username} · {user.role}
          </span>
        )}
        <span className="hidden text-[11px] font-medium sm:block" style={{ color: "var(--th-text-muted)" }}>Native RustDesk workflow</span>
        <span className="h-1 w-1 rounded-full hidden sm:block" style={{ background: "var(--th-border-default)" }} />
        <span className="text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>Developer preview</span>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggle}
          className="rounded-md border p-1.5 transition"
          style={{
            borderColor: "var(--th-border-default)",
            background: "var(--th-bg-surface)",
            color: "var(--th-text-muted)",
          }}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark"
            ? <Sun className="h-3.5 w-3.5" />
            : <Moon className="h-3.5 w-3.5" />
          }
        </button>

        {user && (
          <button
            type="button"
            onClick={logout}
            className="rounded-md border p-1.5 transition"
            style={{
              borderColor: "var(--th-border-default)",
              background: "var(--th-bg-surface)",
              color: "var(--th-text-muted)",
            }}
            title="Logout"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
