import { useEffect, useState } from "react";
import { Copy, KeyRound, Link2, LogOut, Monitor, Moon, Sun, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useAppData } from "../contexts/AppDataContext";
import ChangePasswordModal from "../components/ChangePasswordModal";
import { type ConnectPreference, listConnectPreferences, resetConnectPreference } from "../api/connect";
import pkg from "../../package.json";

/**
 * Settings (docs/reference/MOBILE-DESIGN-SPEC.md — Settings). Phase 6 adds
 * System theme, Preferences (default landing screen — a real, working
 * preference, wired into Login.tsx) and Diagnostics. Notifications are
 * intentionally NOT here yet: Web Push needs backend infra (VAPID,
 * subscriptions) that does not exist — see Known Limitations; adding the
 * toggle now would be a non-functional placeholder, which the Quality
 * Rules forbid.
 */

const DEFAULT_SCREEN_KEY = "techi.preferences.defaultScreen";
export type DefaultScreen = "/" | "/devices" | "/alerts";

export function getPreferredDefaultScreen(): DefaultScreen {
  if (typeof window === "undefined") return "/";
  const stored = window.localStorage.getItem(DEFAULT_SCREEN_KEY);
  return stored === "/devices" || stored === "/alerts" ? stored : "/";
}

function Section({
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
      <div className="p-4">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { user, logout } = useAuth();
  const { themePreference, setThemeMode } = useTheme();
  const { fleetOverview, realtimeStatus } = useAppData();
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [defaultScreen, setDefaultScreen] = useState<DefaultScreen>(getPreferredDefaultScreen);
  const [copied, setCopied] = useState(false);
  const [connectPreferences, setConnectPreferences] = useState<ConnectPreference[]>([]);

  useEffect(() => {
    let active = true;
    listConnectPreferences()
      .then((prefs) => { if (active) setConnectPreferences(prefs); })
      .catch(() => { /* Settings should still render without this section */ });
    return () => { active = false; };
  }, []);

  const handleResetConnectPreference = async (pref: ConnectPreference) => {
    try {
      await resetConnectPreference(pref.platform, pref.device_id ?? undefined);
      setConnectPreferences((current) =>
        current.filter((p) => !(p.platform === pref.platform && p.device_id === pref.device_id)));
    } catch {
      // Best-effort — the list will just re-fetch correctly next visit.
    }
  };

  const themeOptions = [
    { id: "dark" as const, label: "Dark", icon: Moon },
    { id: "light" as const, label: "Light", icon: Sun },
    { id: "system" as const, label: "System", icon: Monitor },
  ];

  const screenOptions: { id: DefaultScreen; label: string }[] = [
    { id: "/", label: "Dashboard" },
    { id: "/devices", label: "Devices" },
    { id: "/alerts", label: "Alerts" },
  ];

  const handleDefaultScreen = (id: DefaultScreen) => {
    setDefaultScreen(id);
    window.localStorage.setItem(DEFAULT_SCREEN_KEY, id);
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

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 md:max-w-2xl">
      <Section title="Appearance">
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {themeOptions.map(({ id, label, icon: Icon }) => {
            const active = themePreference === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setThemeMode(id)}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl text-[13px] font-bold transition-colors"
                style={{
                  background: active ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
                  border: `1px solid ${active ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
                  color: active ? "var(--th-accent)" : "var(--th-text-secondary)",
                }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </div>
      </Section>

      {user && (
        <Section title="Account">
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[14px] font-extrabold" style={{ color: "var(--th-text-primary)" }}>
                {user.display_name || user.username}
              </p>
              {user.email && (
                <p className="mt-0.5 text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                  {user.email}
                </p>
              )}
              <p
                className="mt-1 text-[11px] font-bold uppercase tracking-[0.08em]"
                style={{ color: "var(--th-text-muted)", fontFamily: '"JetBrains Mono", monospace' }}
              >
                {user.role}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowChangePwd(true)}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl text-[13px] font-bold"
              style={{
                background: "var(--th-btn-secondary-bg)",
                border: "1px solid var(--th-border-subtle)",
                color: "var(--th-text-primary)",
              }}
            >
              <KeyRound className="h-4 w-4" />
              Change password
            </button>
          </div>
        </Section>
      )}

      <Section title="Preferences">
        <p className="mb-[10px] text-[12px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
          Default screen on open
        </p>
        <div className="flex gap-2" role="radiogroup" aria-label="Default screen">
          {screenOptions.map(({ id, label }) => {
            const active = defaultScreen === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleDefaultScreen(id)}
                className="flex min-h-[40px] flex-1 items-center justify-center rounded-lg text-[12.5px] font-bold transition-colors"
                style={{
                  background: active ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
                  border: `1px solid ${active ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
                  color: active ? "var(--th-accent)" : "var(--th-text-secondary)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Section>

      {connectPreferences.length > 0 && (
        <Section title="Connect Defaults">
          <p className="mb-[10px] text-[12px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
            "Always use this method" choices from the Connect menu — per platform,
            or per device when an override is set. These are yours alone, not shared
            with other operators.
          </p>
          <div className="flex flex-col gap-2">
            {connectPreferences.map((pref) => (
              <div
                key={`${pref.platform}-${pref.device_id ?? "platform"}`}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                style={{ background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)" }}
              >
                <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--th-text-primary)" }}>
                  <Link2 className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-muted)" }} />
                  <span className="font-bold capitalize">{pref.platform}</span>
                  {pref.device_id && (
                    <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                      device #{pref.device_id}
                    </span>
                  )}
                  <span style={{ color: "var(--th-text-muted)" }}>→</span>
                  <span className="font-semibold">{pref.method_id}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleResetConnectPreference(pref)}
                  title="Reset to the platform default"
                  className="flex-none rounded p-1 hover:bg-[var(--th-bg-card-hover)]"
                >
                  <X className="h-3.5 w-3.5" style={{ color: "var(--th-text-faint)" }} />
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Diagnostics">
        <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[12.5px]">
          <dt style={{ color: "var(--th-text-muted)" }}>Realtime</dt>
          <dd
            className="font-semibold"
            style={{ color: realtimeStatus === "connected" ? "var(--th-status-online)" : "var(--th-status-warning)" }}
          >
            {realtimeStatus}
          </dd>
          <dt style={{ color: "var(--th-text-muted)" }}>App version</dt>
          <dd className="font-semibold" style={{ color: "var(--th-text-primary)", fontFamily: '"JetBrains Mono", monospace' }}>
            v{pkg.version}
          </dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Active agent</dt>
          <dd className="font-semibold" style={{ color: "var(--th-text-primary)", fontFamily: '"JetBrains Mono", monospace' }}>
            {fleetOverview?.active_agent_version ?? "—"}
          </dd>
        </dl>
        <button
          type="button"
          onClick={() => void handleCopyDiagnostics()}
          className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg text-[12.5px] font-bold"
          style={{ background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-primary)" }}
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied!" : "Copy diagnostic info"}
        </button>
      </Section>

      <button
        type="button"
        onClick={logout}
        className="flex min-h-[48px] items-center justify-center gap-2 rounded-[14px] text-[13.5px] font-extrabold"
        style={{
          background: "var(--th-btn-danger-bg)",
          border: "1px solid color-mix(in srgb, var(--th-status-critical) 30%, transparent)",
          color: "var(--th-status-critical)",
        }}
      >
        <LogOut className="h-[18px] w-[18px]" />
        Sign out
      </button>

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}
    </div>
  );
}
