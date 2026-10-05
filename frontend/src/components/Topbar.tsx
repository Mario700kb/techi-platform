import { Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import TopbarClock from "./TopbarClock";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { theme, toggle } = useTheme();

  return (
    <div
      className="relative flex h-16 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-4"
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
        </div>
      </div>

      {/* Absolutely centred so it stays mid-bar whatever sits left and right. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:block">
        <TopbarClock />
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
      </div>
    </div>
  );
}
