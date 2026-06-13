import { useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Monitor, Bell, Menu } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";

interface BottomNavProps {
  onOpenMenu: () => void;
}

export function BottomNav({ onOpenMenu }: BottomNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { alertCount } = useAppData();
  const totalAlerts = alertCount.total_open;

  const tabs = [
    {
      label: "Dashboard",
      icon: LayoutDashboard,
      to: "/",
      exact: true,
      badge: 0,
      action: undefined as (() => void) | undefined,
    },
    {
      label: "Devices",
      icon: Monitor,
      to: "/devices",
      exact: false,
      badge: 0,
      action: undefined as (() => void) | undefined,
    },
    {
      label: "Alerts",
      icon: Bell,
      to: "/devices?filter=needs_attention",
      exact: false,
      badge: totalAlerts,
      action: undefined as (() => void) | undefined,
    },
    {
      label: "Menu",
      icon: Menu,
      to: null as string | null,
      exact: false,
      badge: 0,
      action: onOpenMenu,
    },
  ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: "var(--th-bg-sidebar)",
        borderTop: "1px solid var(--th-border-subtle)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-stretch">
        {tabs.map(({ label, icon: Icon, to, exact, badge, action }) => {
          const basePath = to ? to.split("?")[0] : null;
          const isActive = basePath
            ? exact
              ? location.pathname === basePath
              : location.pathname.startsWith(basePath)
            : false;

          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                if (action) action();
                else if (to) navigate(to);
              }}
              className="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 transition-colors active:bg-white/[0.04]"
              style={{
                color: isActive ? "#f97316" : "var(--th-text-muted)",
                minHeight: 56,
              }}
            >
              <span className="relative">
                <Icon className="h-5 w-5" />
                {badge > 0 && (
                  <span
                    className="absolute -right-2.5 -top-2.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none text-white"
                    style={{ background: "#ef4444" }}
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-semibold">{label}</span>
              {isActive && (
                <span
                  className="absolute bottom-0 rounded-full"
                  style={{
                    left: "20%",
                    right: "20%",
                    height: 2,
                    background: "#f97316",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
