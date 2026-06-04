import { KeyRound, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import ChangePasswordModal from "./ChangePasswordModal";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
          <img
            src="/brand/techi-logo-dark.png"
            alt="TECHI"
            className="h-6 w-auto max-w-[96px] flex-none object-contain"
            onError={(e) => {
              e.currentTarget.src = "/brand/techi-mark-dark.png";
            }}
          />
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
          <div className="relative" ref={menuRef}>
            {/* User pill — click to open menu */}
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="th-btn-secondary th-btn inline-flex min-h-9 items-center gap-2 rounded-lg border px-2.5 py-1.5"
              aria-haspopup="true"
              aria-expanded={menuOpen}
            >
              <span className="max-w-[160px] truncate text-sm font-semibold">
                {user.display_name || user.username}
              </span>
            </button>

            {/* Dropdown */}
            {menuOpen && (
              <>
                {/* Click-outside overlay */}
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  className="absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-xl shadow-2xl"
                  style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
                >
                  {/* Account label */}
                  <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold truncate" style={{ color: "var(--th-text-primary)" }}>
                        {user.display_name || user.username}
                      </p>
                      <span
                        className="shrink-0 rounded border border-techi-orange/25 bg-techi-orange/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-200"
                        style={{ fontFamily: '"JetBrains Mono", monospace' }}
                      >
                        {user.role}
                      </span>
                    </div>
                    <p className="text-[10px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                      {user.email}
                    </p>
                  </div>

                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => { setMenuOpen(false); setShowChangePwd(true); }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs font-medium transition hover:bg-white/[0.05]"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      <KeyRound className="h-3.5 w-3.5 flex-none" />
                      Change Password
                    </button>

                    <button
                      type="button"
                      onClick={() => { setMenuOpen(false); logout(); }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs font-medium transition hover:bg-white/[0.05]"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      <LogOut className="h-3.5 w-3.5 flex-none" />
                      Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}
      </div>
    </div>
  );
}
