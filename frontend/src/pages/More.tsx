import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Info, LogOut, Monitor, Settings as SettingsIcon, Shield } from "lucide-react";
import { ALL_NAV_ITEMS, NavItem } from "../components/navigation";
import { useVisibleNav } from "../hooks/useNavigation";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import { TONE } from "../utils/deviceStatus";
import pkg from "../../package.json";

/**
 * More screen (MOBILE-DESIGN-SPEC.md — More). Replaces the mobile slide-in
 * sidebar: the signed-in user, Workspace, Desktop console (dimmed, still
 * navigable) and App. Inventory is intentionally absent (placeholder page).
 */

const ROLE_TONE: Record<string, string> = {
  owner: "var(--th-accent)",
  admin: TONE.warning,
  operator: TONE.info,
  readonly: TONE.neutral,
};

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="th-mgroup th-onb-enter">
      <h2 className="th-mgroup-title">{title}</h2>
      <div className="th-onb-card overflow-hidden">{children}</div>
    </section>
  );
}

function NavRow({
  item,
  desktop = false,
  onNavigate,
}: {
  item: NavItem;
  desktop?: boolean;
  onNavigate: (to: string) => void;
}) {
  const Icon = item.icon;
  return (
    <button type="button" onClick={() => onNavigate(item.to)} className="th-mrow" data-dim={desktop || undefined}>
      <span
        className="th-onb-icon !h-8 !w-8"
        style={{ "--onb-tone": desktop ? "var(--th-text-muted)" : "var(--th-accent)" } as CSSProperties}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="th-mrow-label">
        <strong>{item.label}</strong>
      </span>
      <span className="th-mrow-end">
        {desktop && (
          <span className="th-status-chip !h-6 !px-2 !text-[11px]">
            <Monitor className="h-3 w-3" />
            Desktop only
          </span>
        )}
        <ChevronRight className="h-4 w-4" />
      </span>
    </button>
  );
}

export default function More() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { fleetOverview } = useAppData();
  const { canSee } = useVisibleNav();

  const workspace = ALL_NAV_ITEMS.filter((i) => i.mobile === "workspace" && canSee(i));
  const desktopConsole = ALL_NAV_ITEMS.filter((i) => i.mobile === "desktop" && canSee(i));
  const displayName = user ? user.display_name || user.username : "";
  const roleTone = ROLE_TONE[user?.role ?? ""] ?? TONE.neutral;
  const agentVersion = fleetOverview?.active_agent_version;

  return (
    <div className="premium-page th-onb mx-auto flex w-full max-w-md flex-col gap-5 md:max-w-2xl">
      {user && (
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="th-onb-card th-mprofile th-onb-enter"
          aria-label={`${displayName}, open settings`}
        >
          <span className="th-settings-avatar !h-12 !w-12" aria-hidden="true">
            {displayName.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[16px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {displayName}
            </span>
            <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {user.email || user.username}
            </span>
          </span>
          <span className="th-status-chip !h-6 capitalize" style={{ "--chip-tone": roleTone } as CSSProperties}>
            <Shield className="h-3 w-3" style={{ color: roleTone }} />
            {user.role}
          </span>
        </button>
      )}

      {workspace.length > 0 && (
        <Group title="Workspace">
          {workspace.map((item) => (
            <NavRow key={item.to} item={item} onNavigate={navigate} />
          ))}
        </Group>
      )}

      {desktopConsole.length > 0 && (
        <Group title="Desktop console">
          {desktopConsole.map((item) => (
            <NavRow key={item.to} item={item} desktop onNavigate={navigate} />
          ))}
        </Group>
      )}

      <Group title="App">
        <button type="button" onClick={() => navigate("/settings")} className="th-mrow">
          <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": TONE.info } as CSSProperties}>
            <SettingsIcon className="h-4 w-4" />
          </span>
          <span className="th-mrow-label">
            <strong>Settings</strong>
            <small>Theme, account, diagnostics</small>
          </span>
          <span className="th-mrow-end">
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
        <div className="th-mrow" data-static="true">
          <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": TONE.neutral } as CSSProperties}>
            <Info className="h-4 w-4" />
          </span>
          <span className="th-mrow-label">
            <strong>Version</strong>
          </span>
          <span className="th-mrow-end font-mono text-[12px]">
            v{pkg.version}
            {agentVersion ? ` · agent ${agentVersion}` : ""}
          </span>
        </div>
        <button type="button" onClick={logout} className="th-mrow" data-tone="danger">
          <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": TONE.critical } as CSSProperties}>
            <LogOut className="h-4 w-4" />
          </span>
          <span className="th-mrow-label">
            <strong>Sign out</strong>
          </span>
        </button>
      </Group>

      <p className="pb-2 text-center font-mono text-[11px]" style={{ color: "var(--th-text-faint)" }}>
        TECHI Connect
      </p>
    </div>
  );
}
