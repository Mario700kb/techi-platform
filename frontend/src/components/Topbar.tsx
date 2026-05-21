import { ChevronDown, ClipboardList, KeyRound, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun, User, Users, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { user, logout, can } = useAuth();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div
      className="flex h-16 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-4"
      style={{
        background: "var(--th-bg-topbar)",
        borderBottomColor: "var(--th-border-default)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="th-icon-btn"
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
          <span
            className="flex-none text-[10px] font-bold uppercase tracking-[0.22em]"
            style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-accent)" }}
          >
            TECHI
          </span>
          <span className="h-3 w-px" style={{ background: "var(--th-border-default)" }} />
          <span className="truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            Remote Dashboard
          </span>
        </div>
      </div>

      <div className="flex flex-none items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className="th-icon-btn"
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
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="th-btn-secondary th-btn inline-flex min-h-9 items-center gap-2 rounded-lg border px-2.5 py-1.5"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
                <User className="h-3.5 w-3.5" />
              </span>
              <span className="hidden max-w-[150px] truncate text-sm font-semibold sm:inline">
                {user.display_name || user.username}
              </span>
              <span className="hidden rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider sm:inline" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                {user.role}
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="user-menu-dark absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 rounded-lg border border-white/[0.10] bg-[#131316] p-2 shadow-2xl"
                style={{ boxShadow: "0 20px 55px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.05)" }}
              >
                <div className="px-2.5 pb-2 pt-1.5">
                  <p className="truncate text-sm font-semibold text-white">{user.display_name || user.username}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="rounded border border-techi-orange/25 bg-techi-orange/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-200" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                      {user.role}
                    </span>
                    <span className="truncate text-xs font-medium text-slate-500">{user.username}</span>
                  </div>
                </div>
                <div className="my-1 border-t border-white/[0.07]" />
                <button type="button" className="th-menu-row th-menu-row-disabled" disabled>
                  <User className="h-4 w-4" />
                  My profile
                </button>
                <button type="button" className="th-menu-row th-menu-row-disabled" disabled>
                  <KeyRound className="h-4 w-4" />
                  Change password
                </button>
                {can("admin") ? (
                  <>
                    <Link to="/operators" className="th-menu-row" onClick={() => setMenuOpen(false)}>
                      <Users className="h-4 w-4" />
                      Operators
                    </Link>
                    <Link to="/audit" className="th-menu-row" onClick={() => setMenuOpen(false)}>
                      <ClipboardList className="h-4 w-4" />
                      Audit Log
                    </Link>
                    <Link to="/deployment" className="th-menu-row" onClick={() => setMenuOpen(false)}>
                      <Wrench className="h-4 w-4" />
                      Deployment
                    </Link>
                  </>
                ) : (
                  <>
                    <button type="button" className="th-menu-row th-menu-row-disabled" disabled><Users className="h-4 w-4" />Operators</button>
                    <button type="button" className="th-menu-row th-menu-row-disabled" disabled><ClipboardList className="h-4 w-4" />Audit Log</button>
                    <button type="button" className="th-menu-row th-menu-row-disabled" disabled><Wrench className="h-4 w-4" />Deployment</button>
                  </>
                )}
                <button type="button" className="th-menu-row th-menu-row-disabled" disabled>
                  <Settings className="h-4 w-4" />
                  Settings
                </button>
                <div className="my-1 border-t border-white/[0.07]" />
                <button
                  type="button"
                  className="th-menu-row th-menu-row-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
