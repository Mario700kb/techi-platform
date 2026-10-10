import { useNavigate } from "react-router-dom";
import { Info, LogOut, Monitor, Settings as SettingsIcon } from "lucide-react";
import { ALL_NAV_ITEMS, NavItem } from "../components/navigation";
import { useVisibleNav } from "../hooks/useNavigation";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import pkg from "../../package.json";

/**
 * More screen (MOBILE-DESIGN-SPEC.md — More). Replaces the mobile slide-in
 * sidebar. Sections: user, Workspace, Desktop console (dimmed, still
 * navigable — Implementation Note #3), App. Inventory is intentionally
 * absent (placeholder page — audit finding).
 */

type Row = NavItem & { note?: string };

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-[14px]"
      style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
    >
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
        <p
          className="text-[11px] font-extrabold uppercase tracking-[0.08em]"
          style={{ color: "var(--th-text-muted)" }}
        >
          {title}
        </p>
      </div>
      {children}
    </div>
  );
}

function MoreRow({
  row,
  dim = false,
  onNavigate,
}: {
  row: Row;
  dim?: boolean;
  onNavigate: (to: string) => void;
}) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      onClick={() => onNavigate(row.to)}
      className="flex min-h-[48px] w-full items-center gap-3 px-4 py-[13px] text-left text-[14px] font-bold transition-colors"
      style={{
        color: dim ? "var(--th-text-muted)" : "var(--th-text-primary)",
        borderBottom: "1px solid var(--th-border-subtle)",
      }}
    >
      <Icon className="h-[18px] w-[18px] flex-none" />
      {row.label}
      {row.note && (
        <span
          className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold"
          style={{ color: "var(--th-text-muted)" }}
        >
          <Monitor className="h-3 w-3" />
          {row.note}
        </span>
      )}
    </button>
  );
}

export default function More() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { fleetOverview } = useAppData();
  const { canSee } = useVisibleNav();

  const workspace: Row[] = ALL_NAV_ITEMS.filter((i) => i.mobile === "workspace" && canSee(i));
  const desktopConsole: Row[] = ALL_NAV_ITEMS
    .filter((i) => i.mobile === "desktop" && canSee(i))
    .map((i) => ({ ...i, note: "Desktop only" }));
  const initial = user ? (user.display_name || user.username).charAt(0).toUpperCase() : "?";
  const agentVersion = fleetOverview?.active_agent_version;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 md:max-w-2xl">
      {/* User */}
      {user && (
        <div
          className="flex items-center gap-3 rounded-[14px] p-4"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        >
          <span
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-[16px] font-extrabold"
            style={{
              background: "var(--th-accent-glow)",
              border: "1px solid var(--th-accent-border)",
              color: "var(--th-accent)",
            }}
          >
            {initial}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-extrabold" style={{ color: "var(--th-text-primary)" }}>
              {user.display_name || user.username}
            </p>
            <p className="text-[12px] font-medium capitalize" style={{ color: "var(--th-text-muted)" }}>
              {user.role}
            </p>
          </div>
        </div>
      )}

      {workspace.length > 0 && (
        <SectionCard title="Workspace">
          {workspace.map((row) => (
            <MoreRow key={row.to} row={row} onNavigate={navigate} />
          ))}
        </SectionCard>
      )}

      {desktopConsole.length > 0 && (
        <SectionCard title="Desktop console">
          {desktopConsole.map((row) => (
            <MoreRow key={row.to} row={row} dim onNavigate={navigate} />
          ))}
        </SectionCard>
      )}

      <SectionCard title="App">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="flex min-h-[48px] w-full items-center gap-3 px-4 py-[13px] text-left text-[14px] font-bold"
          style={{ color: "var(--th-text-primary)", borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <SettingsIcon className="h-[18px] w-[18px] flex-none" />
          Settings
          <span className="ml-auto text-[11px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
            theme · account
          </span>
        </button>
        <div
          className="flex min-h-[48px] w-full items-center gap-3 px-4 py-[13px] text-[14px] font-bold"
          style={{ color: "var(--th-text-primary)", borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <Info className="h-[18px] w-[18px] flex-none" style={{ color: "var(--th-text-secondary)" }} />
          Version
          <span
            className="ml-auto text-[11px] font-semibold"
            style={{ color: "var(--th-text-muted)", fontFamily: '"JetBrains Mono", monospace' }}
          >
            v{pkg.version}
            {agentVersion ? ` · agent ${agentVersion}` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex min-h-[48px] w-full items-center gap-3 px-4 py-[13px] text-left text-[14px] font-bold"
          style={{ color: "var(--th-status-critical)" }}
        >
          <LogOut className="h-[18px] w-[18px] flex-none" />
          Sign out
        </button>
      </SectionCard>

      {/* subtle footer mark */}
      <p
        className="px-2 pb-2 text-center text-[11px] font-semibold"
        style={{ color: "var(--th-text-faint)", fontFamily: '"JetBrains Mono", monospace' }}
      >
        TECHI Connect
      </p>
    </div>
  );
}
