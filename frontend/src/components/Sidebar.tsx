import { Home, Cpu, Folder, KeyRound, Building2, Users, ClipboardList, Package } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";

const navItems = [
  { label: "Dashboard", to: "/", icon: Home, minRole: null },
  { label: "Devices", to: "/devices", icon: Folder, minRole: null },
  { label: "Clients", to: "/clients", icon: Building2, minRole: null },
  { label: "Enrollment", to: "/enrollment-bootstrap", icon: KeyRound, minRole: null },
  { label: "Packages", to: "/agent-packages", icon: Package, minRole: null },
  { label: "Inventory", to: "/inventory", icon: Cpu, minRole: null },
  { label: "Operators", to: "/operators", icon: Users, minRole: "admin" as const },
  { label: "Audit Log", to: "/audit", icon: ClipboardList, minRole: "admin" as const },
];

interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: () => void;
}

export default function Sidebar({ collapsed, onCollapsedChange, onNavigate }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const { user, can } = useAuth();
  const { theme } = useTheme();
  const expanded = !collapsed || hovered;

  return (
    <aside
      className={`flex flex-col transition-all duration-200 ${
        expanded ? "w-[196px] p-2.5" : "w-[52px] p-2"
      }`}
      style={{
        background: "var(--th-bg-sidebar)",
        borderRight: "1px solid var(--th-border-subtle)",
      }}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => onCollapsedChange?.(!collapsed)}
        className={`mb-3 flex items-center rounded-md transition ${
          expanded ? "px-1 py-0.5" : "justify-center py-0.5"
        }`}
        style={{ color: "var(--th-text-muted)" }}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <img
          src={expanded
            ? (theme === "light" ? "/brand/techi-logo.webp" : "/brand/techi-logo-dark.png")
            : "/brand/techi-mark-dark.png"}
          alt="techi"
          className={expanded ? "h-7 w-auto max-w-[124px] object-contain" : "h-6 w-6 object-contain"}
          style={!expanded && theme === "light" ? { filter: "brightness(0) opacity(0.65)" } : {}}
        />
      </button>

      {expanded && (
        <p className="mb-1 px-2 text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--th-sidebar-label)" }}>
          Navigation
        </p>
      )}

      <nav className="space-y-0.5">
        {navItems.filter((item) => !item.minRole || can(item.minRole)).map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              title={expanded ? undefined : item.label}
              onClick={onNavigate}
              className={({ isActive }) =>
                `flex items-center rounded-md py-1.5 text-sm transition-all duration-120 ${
                  expanded ? "gap-2.5 px-2.5" : "justify-center px-0"
                } ${
                  isActive
                    ? "bg-techi-orange/[0.11] text-white shadow-[inset_2px_0_0_#ff553f,inset_0_0_0_1px_rgba(255,85,63,0.16)]"
                    : "hover:bg-white/[0.05] hover:text-white"
                }`
              }
              style={({ isActive }) =>
                isActive
                  ? {}
                  : { color: "var(--th-text-secondary)" }
              }
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {expanded && <span className="text-[13px] font-medium">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto pt-4">
        <div className="border-t" style={{ borderColor: "var(--th-sidebar-divider)" }} />
        {expanded && (
          <div className="mt-3 px-2">
            <p className="text-[10px] font-medium" style={{ color: "var(--th-text-muted)" }}>v1.0 · MSP Console</p>
            {user && <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-tertiary)" }}>{user.role}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}
