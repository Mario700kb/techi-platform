import { ChevronDown, ChevronUp, KeyRound, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import ChangePasswordModal from "./ChangePasswordModal";
import pkg from "../../package.json";

interface AccountMenuProps {
  /** Icon-only trigger for the collapsed sidebar; the menu then opens to the side. */
  compact?: boolean;
  onNavigate?: () => void;
}

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

/** Signed-in operator: identity, account actions, theme and sign-out in one place. */
export default function AccountMenu({ compact = false, onNavigate }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuth();
  const { themePreference, setThemeMode } = useTheme();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const name = user.display_name || user.username;
  const initial = name.charAt(0).toUpperCase();
  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`th-nav-item w-full ${compact ? "justify-center px-0" : "py-2"}`}
        data-active={open}
        title={compact ? name : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="th-avatar">{initial}</span>
        {!compact && (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>{name}</span>
              <span className="block truncate text-[12px] font-normal" style={{ color: "var(--th-text-muted)" }}>{user.email || user.username}</span>
            </span>
            {open
              ? <ChevronDown className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-muted)" }} />
              : <ChevronUp className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />}
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={`th-menu absolute ${compact ? "bottom-0 left-full ml-3 w-56" : "bottom-full left-0 right-0 mb-1.5"}`}
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2.5">
            <span className="th-avatar">{initial}</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                <span className="truncate">{name}</span>
                <span className="th-role-chip">{user.role}</span>
              </p>
              <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{user.email || user.username}</p>
            </div>
          </div>

          <div className="th-menu-group">
            <NavLink to="/settings" role="menuitem" className="th-menu-item" onClick={() => { close(); onNavigate?.(); }}>
              <Settings className="h-4 w-4" /> Settings
            </NavLink>
            <button type="button" role="menuitem" className="th-menu-item" onClick={() => { close(); setShowChangePwd(true); }}>
              <KeyRound className="h-4 w-4" /> Change password
            </button>
          </div>

          <div className="th-menu-group">
            <p className="th-menu-label">Theme</p>
            <div className="th-segmented mx-2.5 mb-1" role="radiogroup" aria-label="Theme">
              {THEMES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={themePreference === id}
                  onClick={() => setThemeMode(id)}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="th-menu-group">
            <button type="button" role="menuitem" className="th-menu-item th-menu-item-danger" onClick={() => { close(); logout(); }}>
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>

          <p className="flex items-center justify-between px-2.5 py-1.5 text-[11px]" style={{ color: "var(--th-text-faint)", borderTop: "1px solid var(--th-border-subtle)" }}>
            <span>TECHI Connect</span>
            <span className="tabular-nums">v{pkg.version}</span>
          </p>
        </div>
      )}

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}
    </div>
  );
}
