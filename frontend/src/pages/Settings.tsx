import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  Activity,
  Bell,
  Check,
  Copy,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Monitor,
  MonitorCog,
  Moon,
  Palette,
  Shield,
  Sun,
  X,
  UserRoundPen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useAppData } from "../contexts/AppDataContext";
import ChangePasswordModal from "../components/ChangePasswordModal";
import EditProfileModal from "../components/EditProfileModal";
import SecurityCard from "../components/security/SecurityCard";
import RemoteSupportPasswordsCard from "../components/security/RemoteSupportPasswordsCard";
import { DefaultScreen, getPreferredDefaultScreen, setPreferredDefaultScreen } from "../utils/defaultScreen";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import { type ConnectPreference, listConnectPreferences, resetConnectPreference } from "../api/connect";
import { TONE } from "../utils/deviceStatus";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import pkg from "../../package.json";

/**
 * Settings (docs/reference/MOBILE-DESIGN-SPEC.md — Settings). Notifications
 * are intentionally not here: Web Push needs backend infra (VAPID,
 * subscriptions) that does not exist, and a toggle without it would be a
 * non-functional placeholder.
 */

const ROLE_TONE: Record<string, string> = {
  owner: "var(--th-accent)",
  admin: TONE.warning,
  operator: TONE.info,
  readonly: TONE.neutral,
};

interface ChoiceOption<T extends string> {
  id: T;
  label: string;
  hint: string;
  icon: LucideIcon;
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="th-choice-grid" role="radiogroup" aria-label={label}>
      {options.map(({ id, label: optionLabel, hint, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className="th-choice"
        >
          <span
            className="th-onb-icon !h-8 !w-8"
            style={{ "--onb-tone": value === id ? "var(--th-accent)" : "var(--th-text-muted)" } as CSSProperties}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <strong>{optionLabel}</strong>
            <small>{hint}</small>
          </span>
          <span className="th-choice-check" aria-hidden="true">
            <Check className="h-2.5 w-2.5" />
          </span>
        </button>
      ))}
    </div>
  );
}

const THEME_OPTIONS: ChoiceOption<"dark" | "light" | "system">[] = [
  { id: "dark", label: "Dark", hint: "Always dark", icon: Moon },
  { id: "light", label: "Light", hint: "Always light", icon: Sun },
  { id: "system", label: "System", hint: "Matches your OS", icon: Monitor },
];

const SCREEN_OPTIONS: ChoiceOption<DefaultScreen>[] = [
  { id: "/", label: "Dashboard", hint: "Fleet overview", icon: LayoutDashboard },
  { id: "/devices", label: "Devices", hint: "Device list", icon: MonitorCog },
  { id: "/alerts", label: "Alerts", hint: "Open alerts", icon: Bell },
];

export default function Settings() {
  const { user, logout, reloadSession } = useAuth();
  const { themePreference, setThemeMode } = useTheme();
  const { fleetOverview, realtimeStatus } = useAppData();
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [defaultScreen, setDefaultScreen] = useState<DefaultScreen>(getPreferredDefaultScreen);
  const [copied, setCopied] = useState(false);
  const [connectPreferences, setConnectPreferences] = useState<ConnectPreference[]>([]);

  useEffect(() => {
    let active = true;
    listConnectPreferences()
      .then((prefs) => {
        if (active) setConnectPreferences(prefs);
      })
      .catch(() => {
        /* Settings should still render without this section */
      });
    return () => {
      active = false;
    };
  }, []);

  const handleResetConnectPreference = async (pref: ConnectPreference) => {
    try {
      await resetConnectPreference(pref.platform, pref.device_id ?? undefined);
      setConnectPreferences((current) =>
        current.filter((p) => !(p.platform === pref.platform && p.device_id === pref.device_id)),
      );
    } catch {
      // Best-effort — the list will just re-fetch correctly next visit.
    }
  };

  const handleDefaultScreen = (id: DefaultScreen) => {
    setDefaultScreen(id);
    setPreferredDefaultScreen(id);
  };

  const handleCopyDiagnostics = async () => {
    const info = [
      `App version: v${pkg.version}`,
      `Active agent: ${fleetOverview?.active_agent_version ?? "—"}`,
      `Realtime status: ${realtimeStatus}`,
      `User: ${user?.username ?? "—"} (${user?.role ?? "—"})`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard permission denied — nothing to recover from client-side
    }
  };

  const displayName = user ? user.display_name || user.username : "";
  const roleTone = ROLE_TONE[user?.role ?? ""] ?? TONE.neutral;
  const realtimeTone = realtimeStatus === "connected" ? TONE.online : TONE.warning;

  return (
    <section className="premium-page th-onb mx-auto w-full max-w-5xl space-y-4">
      <PageHeader
        title="Settings"
        description="Your appearance, account and connection preferences."
        className="hidden md:block"
      />

      {user && (
        <div className="th-onb-card th-onb-enter" style={{ "--i": 0 } as CSSProperties}>
          <div className="th-settings-profile">
            <span className="th-settings-avatar" aria-hidden="true">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-[16px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {displayName}
                </h2>
                <span className="th-status-chip capitalize" style={{ "--chip-tone": roleTone } as CSSProperties}>
                  <Shield className="h-3 w-3" style={{ color: roleTone }} />
                  {user.role}
                </span>
              </div>
              <p className="truncate text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                <span className="font-mono">{user.username}</span>
                {user.email ? ` · ${user.email}` : ""}
              </p>
            </div>
            <div className="th-settings-profile-actions">
              <Button variant="secondary" size="sm" onClick={() => setShowEditProfile(true)}>
                <UserRoundPen className="h-3.5 w-3.5" />
                Edit profile
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowChangePwd(true)}>
                <KeyRound className="h-3.5 w-3.5" />
                Change password
              </Button>
              <Button variant="danger" size="sm" onClick={logout}>
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </Button>
            </div>
          </div>
          <dl className="th-onb-meta th-settings-meta">
            <div>
              <dt>Username</dt>
              <dd className="font-mono">{user.username}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd className="capitalize">{user.role}</dd>
            </div>
            <div>
              <dt>Last sign-in</dt>
              <dd title={formatLocalDateTime(user.last_login_at)}>
                {user.last_login_at ? timeAgo(user.last_login_at) : "—"}
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd className="tabular-nums">
                {user.created_at
                  ? formatLocalDateTime(user.created_at, { day: "numeric", month: "short", year: "numeric" })
                  : "—"}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {user && <SecurityCard style={{ "--i": 1 } as CSSProperties} />}
      {(user?.role === "owner" || user?.role === "admin") && (
        <RemoteSupportPasswordsCard style={{ "--i": 1 } as CSSProperties} />
      )}

      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <div className="th-onb-card th-onb-enter" style={{ "--i": 1 } as CSSProperties}>
          <CardHead icon={Palette} tone="var(--th-accent)" title="Appearance" subtitle="Theme for this browser" />
          <div className="th-onb-body flex-1">
            <ChoiceGroup label="Theme" value={themePreference} options={THEME_OPTIONS} onChange={setThemeMode} />
          </div>
        </div>

        <div className="th-onb-card th-onb-enter" style={{ "--i": 2 } as CSSProperties}>
          <CardHead icon={LayoutDashboard} tone={TONE.info} title="Preferences" subtitle="Default screen on open" />
          <div className="th-onb-body flex-1">
            <ChoiceGroup
              label="Default screen"
              value={defaultScreen}
              options={SCREEN_OPTIONS}
              onChange={handleDefaultScreen}
            />
          </div>
        </div>
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <div className="th-onb-card th-onb-enter" style={{ "--i": 3 } as CSSProperties}>
          <CardHead
            icon={Activity}
            tone={realtimeTone}
            title="Diagnostics"
            subtitle="What support needs to reproduce an issue"
          />
          <div className="th-onb-body flex-1">
            <dl className="th-onb-meta">
              <div>
                <dt>Realtime</dt>
                <dd className="flex items-center gap-1.5 capitalize" style={{ color: realtimeTone }}>
                  <span className="th-onb-dot !h-2 !w-2" style={{ "--swatch": realtimeTone } as CSSProperties} />
                  {realtimeStatus}
                </dd>
              </div>
              <div>
                <dt>Signed in as</dt>
                <dd className="font-mono">{user?.username ?? "—"}</dd>
              </div>
              <div>
                <dt>App version</dt>
                <dd className="font-mono">v{pkg.version}</dd>
              </div>
              <div>
                <dt>Active agent</dt>
                <dd className="font-mono">{fleetOverview?.active_agent_version ?? "—"}</dd>
              </div>
            </dl>
          </div>
          <div className="th-onb-foot flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => void handleCopyDiagnostics()}>
              {copied ? (
                <Check className="h-3.5 w-3.5" style={{ color: TONE.online }} />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy diagnostic info"}
            </Button>
          </div>
        </div>

        <div className="th-onb-card th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
          <CardHead
            icon={Link2}
            tone={TONE.maintenance}
            title="Connect defaults"
            subtitle="Methods you chose to always use, for you only"
          />
          {connectPreferences.length === 0 ? (
            <div className="th-onb-empty">
              <EmptyState
                icon={<Link2 className="h-5 w-5" />}
                title="No saved connect methods"
                description='Pick "Always use this method" in a Connect menu to skip the choice next time.'
              />
            </div>
          ) : (
            <div className="th-onb-body flex-1">
              <ul className="th-batch-list">
                {connectPreferences.map((pref) => (
                  <li key={`${pref.platform}-${pref.device_id ?? "platform"}`}>
                    <span className="th-status-chip !h-5 flex-none !px-1.5 !text-[11px]">
                      {pref.device_id ? "Device" : "Platform"}
                    </span>
                    <span
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
                      style={{ color: "var(--th-text-primary)" }}
                    >
                      <span className="font-medium capitalize">{pref.platform}</span>
                      {pref.device_id && (
                        <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                          device #{pref.device_id}
                        </span>
                      )}
                      <span style={{ color: "var(--th-text-faint)" }}>→</span>
                      <span className="truncate font-mono text-[12px]">{pref.method_id}</span>
                    </span>
                    <button
                      type="button"
                      className="th-onb-action"
                      onClick={() => void handleResetConnectPreference(pref)}
                      title="Reset to the platform default"
                      aria-label={`Reset ${pref.platform} connect default`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}
      {showEditProfile && user && (
        <EditProfileModal user={user} onClose={() => setShowEditProfile(false)} onSaved={reloadSession} />
      )}
    </section>
  );
}
