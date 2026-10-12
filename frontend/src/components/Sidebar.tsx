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
  const { theme } = useTheme();
  const { fleetOverview, totalOpenAlerts, alertCount } = useAppData();
  const { sections } = useVisibleNav();
  const { pathname } = useLocation();
  // Collapsed stays collapsed: hovering does not open it (icons carry their
  // label as a tooltip); only the logo button expands it.
  const expanded = !collapsed;

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
    >
      {/* Brand */}
      {/* Fixed left offsets in both states, so nothing moves while the width
          animates: the symbol sits at 18px (the full logo's symbol lines up
          with the collapsed one), nav icons at 24px, the avatar at 18px. */}
      <div
        className="flex h-14 flex-none items-center overflow-hidden border-b pl-[18px]"
        style={{ borderColor: "var(--th-border-default)" }}
      >
        <button
          type="button"
          onClick={() => onCollapsedChange?.(!collapsed)}
          className="flex items-center rounded-md"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <img
            src={
              expanded
                ? theme === "light"
                  ? "/brand/connect-primary.svg"
                  : "/brand/connect-primary-on-dark.svg"
                : "/brand/connect-symbol.svg"
            }
            alt="TECHI Connect"
            className={expanded ? "h-7 w-auto max-w-[140px] object-contain" : "h-7 w-7 object-contain"}
          />
        </button>
      </div>

      {/* Navigation */}
      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-3" aria-label="Main">
        {sections.map((section, index) => (
          <div key={section.id} className={index === 0 ? "pt-1" : "pt-5"}>
            {section.label && (
              // Same height either way, so the items below do not jump.
              <div className="th-nav-section-slot">
                {expanded ? (
                  <p className="th-nav-section">{section.label}</p>
                ) : (
                  <span className="th-nav-section-rule" aria-hidden="true" />
                )}
              </div>
            )}
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
                      className="th-nav-item"
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
      <div className="flex-none border-t px-3 py-3" style={{ borderColor: "var(--th-sidebar-divider)" }}>
        <AccountMenu compact={!expanded} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
