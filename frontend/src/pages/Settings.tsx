import { useState } from "react";
import { KeyRound, LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useAppData } from "../contexts/AppDataContext";
import ChangePasswordModal from "../components/ChangePasswordModal";
import pkg from "../../package.json";

/**
 * Settings — Phase 1 minimal-but-real scope (MOBILE-DESIGN-SPEC.md,
 * Implementation Note #1): Appearance, Account, About, Sign out.
 * Phase 6 adds System theme, notifications and preferences.
 */

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
  const { theme, toggle } = useTheme();
  const { fleetOverview } = useAppData();
  const [showChangePwd, setShowChangePwd] = useState(false);

  const setTheme = (target: "dark" | "light") => {
    if (theme !== target) toggle();
  };

  const themeOptions = [
    { id: "dark" as const, label: "Dark", icon: Moon },
    { id: "light" as const, label: "Light", icon: Sun },
  ];

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 md:max-w-2xl">
      <Section title="Appearance">
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {themeOptions.map(({ id, label, icon: Icon }) => {
            const active = theme === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(id)}
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

      <Section title="About">
        <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[12.5px]">
          <dt style={{ color: "var(--th-text-muted)" }}>App version</dt>
          <dd
            className="font-semibold"
            style={{ color: "var(--th-text-primary)", fontFamily: '"JetBrains Mono", monospace' }}
          >
            v{pkg.version}
          </dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Active agent</dt>
          <dd
            className="font-semibold"
            style={{ color: "var(--th-text-primary)", fontFamily: '"JetBrains Mono", monospace' }}
          >
            {fleetOverview?.active_agent_version ?? "—"}
          </dd>
        </dl>
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
