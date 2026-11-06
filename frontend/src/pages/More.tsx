import { useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Info, LogOut, Monitor, Settings as SettingsIcon, Shield } from "lucide-react";
import { ALL_NAV_ITEMS, NavItem } from "../components/navigation";
import { useVisibleNav } from "../hooks/useNavigation";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import { TONE } from "../utils/deviceStatus";
import pkg from "../../package.json";

/**
 * More screen (MOBILE-DESIGN-SPEC.md — More). Replaces the mobile slide-in
 * sidebar: the signed-in user, Workspace tiles, the admin pages behind one row,
 * and App. Inventory is intentionally absent (placeholder page).
 */

const ROLE_TONE: Record<string, string> = {
  owner: "var(--th-accent)",
  admin: TONE.warning,
  operator: TONE.info,
  readonly: TONE.neutral,
};

function NavRow({ item, onNavigate }: { item: NavItem; onNavigate: (to: string) => void }) {
  const Icon = item.icon;
  return (
    <button type="button" onClick={() => onNavigate(item.to)} className="th-mrow">
      <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": "var(--th-text-muted)" } as CSSProperties}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="th-mrow-label">
        <strong>{item.label}</strong>
      </span>
      <span className="th-mrow-end">
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
  const [adminOpen, setAdminOpen] = useState(false);

  const workspace = ALL_NAV_ITEMS.filter((i) => i.mobile === "workspace" && canSee(i));
  const desktopConsole = ALL_NAV_ITEMS.filter((i) => i.mobile === "desktop" && canSee(i));
  const displayName = user ? user.display_name || user.username : "";
  const roleTone = ROLE_TONE[user?.role ?? ""] ?? TONE.neutral;
  const agentVersion = fleetOverview?.active_agent_version;

  return (
    <div className="premium-page th-onb th-mmore">
      {user && (
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="th-mmore-hero th-onb-enter"
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
        <section className="th-mmore-section th-onb-enter">
          <h2>Workspace</h2>
          <div className="th-mmore-tiles">
            {workspace.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.to} type="button" onClick={() => navigate(item.to)} className="th-mmore-tile">
                  <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": "var(--th-accent)" } as CSSProperties}>
                    <Icon className="h-4 w-4" />
                  </span>
                  {item.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {desktopConsole.length > 0 && (
        <section className="th-mmore-section th-onb-enter">
          <h2>Administration</h2>
          <div className="th-mmore-list">
            <button
              type="button"
              className="th-mrow"
              aria-expanded={adminOpen}
              onClick={() => setAdminOpen((open) => !open)}
            >
              <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": TONE.neutral } as CSSProperties}>
                <Monitor className="h-4 w-4" />
              </span>
              <span className="th-mrow-label">
                <strong>Admin pages</strong>
                <small>{desktopConsole.length} pages · easiest on a desktop</small>
              </span>
              <ChevronDown className="th-mmore-chevron" data-open={adminOpen || undefined} aria-hidden="true" />
            </button>
            {adminOpen && desktopConsole.map((item) => <NavRow key={item.to} item={item} onNavigate={navigate} />)}
          </div>
        </section>
      )}

      <section className="th-mmore-section th-onb-enter">
        <h2>App</h2>
        <div className="th-mmore-list">
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
        </div>
      </section>
    </div>
  );
}
