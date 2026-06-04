import { Home, Cpu, Folder, KeyRound, Building2, Users, ClipboardList, Package, MonitorCog } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const navItems = [
  { label: "Dashboard", to: "/", icon: Home, minRole: null },
  { label: "Devices", to: "/devices", icon: Folder, minRole: null },
  { label: "Clients", to: "/clients", icon: Building2, minRole: null },
  { label: "Deployment", to: "/deployment", icon: MonitorCog, minRole: null },
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
  const expanded = !collapsed || hovered;

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

      <div className="mt-auto pt-4">
        <div className="border-t" style={{ borderColor: "var(--th-sidebar-divider)" }} />
        {expanded && (
          <div className="mt-3 px-2">
            <p
              className="text-[10px] font-medium"
              style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-text-muted)" }}
            >
              v1.0 · MSP Console
            </p>
            {user && (
              <p
                className="mt-1 text-[10px] font-semibold uppercase tracking-wide"
                style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--th-text-tertiary)" }}
              >
                {user.role}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
