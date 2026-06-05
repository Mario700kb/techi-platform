import { Home, Cpu, Folder, KeyRound, LogOut, Building2, Users, UsersRound, ClipboardList, Package, MonitorCog } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import ChangePasswordModal from "./ChangePasswordModal";

type NavItem = {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  permission: string | null; // null = always visible for authenticated users
};

const navItems: NavItem[] = [
  { label: "Dashboard",  to: "/",                    icon: Home,          permission: null },
  { label: "Devices",    to: "/devices",              icon: Folder,        permission: "view_devices" },
  { label: "Clients",    to: "/clients",              icon: Building2,     permission: "manage_clients" },
  { label: "Deployment", to: "/deployment",           icon: MonitorCog,    permission: "deployment" },
  { label: "Enrollment", to: "/enrollment-bootstrap", icon: KeyRound,      permission: "deployment" },
  { label: "Packages",   to: "/agent-packages",       icon: Package,       permission: "deployment" },
  { label: "Inventory",  to: "/inventory",            icon: Cpu,           permission: "view_inventory" },
  { label: "Operators",  to: "/operators",            icon: Users,         permission: "manage_operators" },
  { label: "Teams",      to: "/teams",                icon: UsersRound,    permission: "manage_teams" },
  { label: "Audit Log",  to: "/audit",                icon: ClipboardList, permission: "audit_log" },
];

interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: () => void;
}

export default function Sidebar({ collapsed, onCollapsedChange, onNavigate }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const { user, logout, hasPermission } = useAuth();
  const expanded = !collapsed || hovered;

  const visibleItems = navItems.filter(
    (item) => item.permission === null || hasPermission(item.permission),
  );

  const userInitial = user
    ? (user.display_name || user.username).charAt(0).toUpperCase()
    : "?";

  return (
    <aside
      className={`flex h-full flex-col ${expanded ? "w-[260px] p-3" : "w-[72px] p-2"}`}
      style={{
        background: "var(--th-bg-sidebar)",
        borderRight: "1px solid var(--th-border-subtle)",
        transition: "width 380ms cubic-bezier(0.32, 0.72, 0, 1), padding 380ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Logo / brand */}
      <button
        type="button"
        onClick={() => onCollapsedChange?.(!collapsed)}
        className={`mb-3 flex items-center rounded-md transition-colors ${
          expanded ? "px-1 py-0.5" : "justify-center py-0.5"
        }`}
        style={{ color: "var(--th-text-muted)" }}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <img
          src={expanded ? "/brand/techi-logo-dark.png" : "/brand/techi-mark-dark.png"}
          alt="techi"
          className={expanded ? "h-7 w-auto max-w-[130px] object-contain" : "h-6 w-6 object-contain"}
          onError={(e) => {
            const img = e.currentTarget;
            if (!img.src.endsWith("techi-mark-dark.png")) {
              img.src = "/brand/techi-mark-dark.png";
            }
          }}
        />
      </button>

      {expanded && (
        <p
          className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-sidebar-label)" }}
        >
          Navigation
        </p>
      )}

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              title={expanded ? undefined : item.label}
              onClick={onNavigate}
              className={({ isActive }) =>
                `flex items-center rounded-md py-1.5 transition-all ${
                  expanded ? "gap-2.5 px-2.5" : "justify-center px-0"
                } ${
                  isActive
                    ? "bg-[#3A1A14] text-[#FF6B47] shadow-[inset_2px_0_0_#E85A3C,inset_0_0_0_1px_rgba(232,90,60,0.18)]"
                    : "hover:bg-white/[0.04] hover:text-white"
                }`
              }
              style={({ isActive }) =>
                isActive ? {} : { color: "var(--th-text-secondary)" }
              }
            >
              <Icon className="h-[15px] w-[15px] shrink-0" />
              {expanded && <span className="text-[13px] font-medium">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* Sticky footer */}
      <div className="mt-auto flex flex-col">

        {/* User identity block */}
        {user && (
          <div
            className="relative"
            style={{ borderTop: "1px solid var(--th-sidebar-divider)" }}
          >
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              className={`w-full transition hover:bg-white/[0.04] ${
                expanded ? "px-3 py-2.5 text-left" : "flex justify-center py-2.5"
              }`}
              title={expanded ? undefined : (user.display_name || user.username)}
              aria-haspopup="true"
              aria-expanded={userMenuOpen}
            >
              {expanded ? (
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                    {user.display_name || user.username}
                  </p>
                  <p
                    className="mt-0.5 text-[9px] font-bold uppercase tracking-widest"
                    style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-sidebar-label)" }}
                  >
                    {user.role}
                  </p>
                </div>
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-techi-orange/20 text-xs font-bold text-orange-200">
                  {userInitial}
                </span>
              )}
            </button>

            {/* User dropdown */}
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div
                  className="absolute bottom-full left-0 z-50 mb-1 min-w-[200px] overflow-hidden rounded-xl shadow-2xl"
                  style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
                >
                  <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
                    <p className="truncate text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
                      {user.display_name || user.username}
                    </p>
                    <p className="text-[10px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                      {user.email}
                    </p>
                    <span
                      className="mt-1 inline-block rounded border border-techi-orange/25 bg-techi-orange/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-200"
                      style={{ fontFamily: '"JetBrains Mono", monospace' }}
                    >
                      {user.role}
                    </span>
                  </div>

                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => { setUserMenuOpen(false); setShowChangePwd(true); }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs font-medium transition hover:bg-white/[0.05]"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      <KeyRound className="h-3.5 w-3.5 flex-none" />
                      Change Password
                    </button>
                    <button
                      type="button"
                      onClick={() => { setUserMenuOpen(false); logout(); }}
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

        {/* TECHI brand footer */}
        <div style={{ borderTop: "1px solid var(--th-sidebar-divider)" }}>
          {expanded && (
            <div className="px-3 py-3">
              <p
                className="text-[10px] font-semibold"
                style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-text-muted)" }}
              >
                TECHI MSP Console
              </p>
              <p
                className="mt-0.5 text-[9px]"
                style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-text-tertiary)" }}
              >
                Version 1.0
              </p>
            </div>
          )}
        </div>
      </div>

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}
    </aside>
  );
}
