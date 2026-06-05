import { Home, Cpu, Folder, KeyRound, Building2, Users, UsersRound, ClipboardList, Package, MonitorCog } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

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
  const { hasPermission } = useAuth();
  const expanded = !collapsed || hovered;

  const visibleItems = navItems.filter(
    (item) => item.permission === null || hasPermission(item.permission),
  );

  return (
    <aside
      className={`flex flex-col ${expanded ? "w-[260px] p-3" : "w-[72px] p-2"}`}
      style={{
        background: "var(--th-bg-sidebar)",
        borderRight: "1px solid var(--th-border-subtle)",
        transition: "width 380ms cubic-bezier(0.32, 0.72, 0, 1), padding 380ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
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

      <nav className="space-y-0.5">
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

      <div className="mt-auto">
        <div className="border-t" style={{ borderColor: "var(--th-sidebar-divider)" }} />
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
    </aside>
  );
}
