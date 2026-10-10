import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { useAppData } from "../contexts/AppDataContext";
import { useVisibleNav } from "../hooks/useNavigation";
import { isNavItemActive, NavBadge } from "./navigation";
import AccountMenu from "./AccountMenu";

interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: () => void;
}

export default function Sidebar({ collapsed, onCollapsedChange, onNavigate }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const { theme } = useTheme();
  const { fleetOverview, totalOpenAlerts, alertCount } = useAppData();
  const { sections } = useVisibleNav();
  const { pathname } = useLocation();
  const expanded = !collapsed || hovered;

  const badgeFor = (badge?: NavBadge): { value: number; tone: "neutral" | "critical" | "warning" } | null => {
    if (badge === "devices") {
      const total = fleetOverview?.stats.total;
      return total ? { value: total, tone: "neutral" } : null;
    }
    if (badge === "alerts") {
      if (!totalOpenAlerts) return null;
      return { value: totalOpenAlerts, tone: (alertCount.by_severity["critical"] ?? 0) > 0 ? "critical" : "warning" };
    }
    return null;
  };

  return (
    <aside
      className={`th-sidebar flex h-full flex-col ${expanded ? "w-[248px]" : "w-[64px]"}`}
      data-expanded={expanded}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Brand */}
      <div className={`flex h-14 flex-none items-center border-b ${expanded ? "px-4" : "justify-center"}`} style={{ borderColor: "var(--th-border-default)" }}>
        <button
          type="button"
          onClick={() => onCollapsedChange?.(!collapsed)}
          className="flex items-center rounded-md"
          title={collapsed ? "Pin sidebar open" : "Collapse sidebar"}
        >
          <img
            src={expanded ? (theme === "light" ? "/brand/techi-logo.webp" : "/brand/techi-logo-dark.png") : "/brand/techi-mark.svg"}
            alt="techi"
            className={expanded ? "h-6 w-auto max-w-[120px] object-contain" : "h-6 w-6 object-contain"}
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.src.endsWith("techi-mark-dark.png")) img.src = "/brand/techi-mark-dark.png";
            }}
          />
        </button>
      </div>

      {/* Navigation */}
      <nav className={`min-h-0 flex-1 overflow-y-auto pb-3 pt-3 ${expanded ? "px-3" : "px-2"}`} aria-label="Main">
        {sections.map((section, index) => (
          <div key={section.id} className={index === 0 ? "pt-1" : "pt-5"}>
            {section.label && (expanded ? (
              <p className="th-nav-section">{section.label}</p>
            ) : (
              <div className="mx-2 mb-3 border-t" style={{ borderColor: "var(--th-sidebar-divider)" }} />
            ))}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = isNavItemActive(item, pathname);
                const badge = badgeFor(item.badge);
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      title={expanded ? undefined : item.label}
                      aria-label={expanded ? undefined : item.label}
                      onClick={onNavigate}
                      className={`th-nav-item ${expanded ? "" : "justify-center px-0"}`}
                      data-active={active}
                    >
                      <span className="relative flex flex-none">
                        <Icon className="h-4 w-4" />
                        {!expanded && badge && badge.tone !== "neutral" && (
                          <span className="th-nav-dot" data-tone={badge.tone} />
                        )}
                      </span>
                      {expanded && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                      {expanded && badge && (
                        <span className="th-nav-badge" data-tone={badge.tone}>
                          {badge.value > 999 ? "999+" : badge.value}
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Account */}
      <div className={`flex-none border-t py-3 ${expanded ? "px-3" : "px-2"}`} style={{ borderColor: "var(--th-sidebar-divider)" }}>
        <AccountMenu compact={!expanded} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
