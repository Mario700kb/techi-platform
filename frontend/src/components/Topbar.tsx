import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";
import NotificationCenter from "./NotificationCenter";
import CommandPalette from "./CommandPalette";
import { locateNav } from "./navigation";
import TopbarClock from "./TopbarClock";

interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function Topbar({ collapsed, onToggleSidebar }: TopbarProps) {
  const { alerts, totalOpenAlerts, reloadAlerts } = useAppData();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { section, label } = locateNav(location.pathname);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="th-topbar">
      {/* Left: sidebar toggle + where you are */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="th-icon-btn th-icon-btn-ghost"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
        <span className="h-5 w-px flex-none" style={{ background: "var(--th-border-default)" }} aria-hidden="true" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 pl-1 text-[13px]">
          {section && (
            <>
              <span className="hidden truncate lg:inline" style={{ color: "var(--th-text-muted)" }}>{section}</span>
              <ChevronRight className="hidden h-3.5 w-3.5 flex-none lg:inline" style={{ color: "var(--th-text-faint)" }} />
            </>
          )}
          <span className="truncate font-semibold" style={{ color: "var(--th-text-primary)" }}>{label}</span>
        </nav>
      </div>

      {/* Center: global device search */}
      <div className="flex justify-center">
        <button type="button" className="th-search th-search-trigger" onClick={() => setPaletteOpen(true)} aria-haspopup="dialog" aria-label="Search everything">
          <Search className="h-4 w-4 flex-none" />
          <span className="flex-1 truncate text-left">Search devices, clients, pages…</span>
          <kbd className="th-kbd hidden lg:inline-flex">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      </div>

      {/* Right: platform time + alerts */}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <div className="hidden xl:block">
          <TopbarClock />
        </div>
        <NotificationCenter
          alerts={alerts}
          totalOpen={totalOpenAlerts}
          onDeviceJump={(deviceId) => navigate(`/devices?device=${deviceId}`)}
          onAlertResolved={reloadAlerts}
        />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  );
}
