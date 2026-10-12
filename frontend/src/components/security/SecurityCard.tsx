import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, KeyRound, LogOut, Monitor, ShieldCheck, ShieldOff, Smartphone, X } from "lucide-react";
import {
  disableMfa,
  getMfaStatus,
  listSessions,
  MfaStatus,
  OperatorSession,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  revokeSession,
} from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";
import { formatLocalDateTime, timeAgo } from "../../utils/time";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { CardHead } from "../ui/PanelCard";
import MfaSetupFlow from "./MfaSetupFlow";
import RecoveryCodes from "./RecoveryCodes";

const TONE_ON = "var(--th-status-online)";
const TONE_OFF = "var(--th-status-warning)";

/** "Chrome on Windows" from a user-agent string; good enough to recognise your own devices. */
export function describeUserAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "Unknown browser", mobile: false };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobile|iPhone|Android/.test(ua) };
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties} role="alert">
      <AlertTriangle className="h-4 w-4" />
      <span>{message}</span>
    </div>
  );
}

function CodeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="th-onb-field">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 11))}
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="123456 or a recovery code"
        className="font-mono"
      />
    </label>
  );
}

function DisableMfaDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disableMfa(password, code);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn off two-factor authentication");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Turn off two-factor authentication"
      subtitle="Your account will be protected by your password only"
      icon={ShieldOff}
      tone="danger"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form="mfa-disable-form" disabled={busy || !password || !code}>
            {busy ? "Turning off…" : "Turn off"}
          </Button>
        </>
      }
    >
      <form id="mfa-disable-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error && <ErrorNote message={error} />}
        <label className="th-onb-field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <CodeField value={code} onChange={setCode} label="Authentication code" />
      </form>
    </Modal>
  );
}

function RegenerateCodesDialog({ account, onClose }: { account: string; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes(await regenerateRecoveryCodes(code));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create new recovery codes");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New recovery codes"
      subtitle="Replaces every code you saved before"
      icon={KeyRound}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        codes ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="mfa-codes-form" disabled={busy || !code}>
              {busy ? "Creating…" : "Create new codes"}
            </Button>
          </>
        )
      }
    >
      {codes ? (
        <RecoveryCodes codes={codes} account={account} />
      ) : (
        <form id="mfa-codes-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          {error && <ErrorNote message={error} />}
          <CodeField value={code} onChange={setCode} label="Authentication code" />
        </form>
      )}
    </Modal>
  );
}

/** Settings → Security: two-factor authentication and signed-in browsers. */
export default function SecurityCard({ style }: { style?: CSSProperties }) {
  const { user, reloadSession } = useAuth();
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<OperatorSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"setup" | "disable" | "codes" | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupEnabled, setSetupEnabled] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const account = user?.email || user?.username || "";

  const load = useCallback(async () => {
    try {
      const [status, rows] = await Promise.all([getMfaStatus(), listSessions()]);
      setMfa(status);
      setSessions(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load security settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = () => {
    setDialog(null);
    void load();
    void reloadSession();
  };

  const revoke = async (id: string | "others") => {
    setRevoking(id);
    try {
      if (id === "others") await revokeOtherSessions();
      else await revokeSession(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out that session");
    } finally {
      setRevoking(null);
    }
  };

  const others = sessions?.filter((s) => !s.current).length ?? 0;
  const enabled = Boolean(mfa?.enabled);

  return (
    <div className="th-onb-card th-onb-enter" style={style}>
      <CardHead
        icon={ShieldCheck}
        tone={enabled ? TONE_ON : TONE_OFF}
        title="Security"
        subtitle="Two-factor authentication and where you are signed in"
      />
      <div className="th-onb-body flex flex-col gap-5">
        {error && <ErrorNote message={error} />}

        <section
          aria-labelledby="mfa-heading"
          className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0">
            <h3
              id="mfa-heading"
              className="flex items-center gap-2 text-[14px] font-semibold"
              style={{ color: "var(--th-text-primary)" }}
            >
              Two-factor authentication
              {mfa && (
                <span
                  className="th-status-chip"
                  style={{ "--chip-tone": enabled ? TONE_ON : TONE_OFF } as CSSProperties}
                >
                  {enabled ? "On" : "Off"}
                </span>
              )}
            </h3>
            <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {!mfa
                ? "Loading…"
                : enabled
                  ? `On since ${formatLocalDateTime(mfa.enabled_at, { day: "numeric", month: "short", year: "numeric" })} · ${mfa.recovery_codes_remaining} recovery code${mfa.recovery_codes_remaining === 1 ? "" : "s"} left`
                  : "Ask for a code from your phone at sign-in, so a stolen password alone cannot open your account."}
            </p>
            {mfa?.required && (
              <p className="mt-1 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                Required for your role.
              </p>
            )}
          </div>
          <div className="flex flex-none flex-wrap gap-2">
            {mfa && !enabled && (
              <Button
                size="sm"
                onClick={() => {
                  setSetupEnabled(false);
                  setDialog("setup");
                }}
              >
                <ShieldCheck className="h-3.5 w-3.5" /> Turn on
              </Button>
            )}
            {mfa && enabled && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setDialog("codes")}>
                  <KeyRound className="h-3.5 w-3.5" /> New recovery codes
                </Button>
                {!mfa.required && (
                  <Button variant="danger" size="sm" onClick={() => setDialog("disable")}>
                    Turn off
                  </Button>
                )}
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="sessions-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="sessions-heading" className="text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
              Signed-in browsers
            </h3>
            {others > 0 && (
              <Button variant="secondary" size="sm" onClick={() => void revoke("others")} disabled={revoking !== null}>
                <LogOut className="h-3.5 w-3.5" /> Sign out the others ({others})
              </Button>
            )}
          </div>
          <ul className="th-batch-list mt-2">
            {(sessions ?? []).map((s) => {
              const { label, mobile } = describeUserAgent(s.user_agent);
              const Icon = mobile ? Smartphone : Monitor;
              return (
                <li key={s.id}>
                  <Icon className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="flex items-center gap-2 text-[13px] font-medium"
                      style={{ color: "var(--th-text-primary)" }}
                    >
                      {label}
                      {s.current && (
                        <span
                          className="th-status-chip !h-5 !px-1.5 !text-[11px]"
                          style={{ "--chip-tone": TONE_ON } as CSSProperties}
                        >
                          This browser
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      {s.ip_address ?? "Unknown address"} · active {timeAgo(s.last_used_at)} · signed in{" "}
                      {formatLocalDateTime(s.created_at, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                  {!s.current && (
                    <button
                      type="button"
                      className="th-onb-action"
                      onClick={() => void revoke(s.id)}
                      disabled={revoking !== null}
                      title="Sign out this browser"
                      aria-label={`Sign out ${label}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {dialog === "setup" && (
        <Modal
          title="Turn on two-factor authentication"
          subtitle="About a minute, with your phone"
          icon={ShieldCheck}
          size="md"
          busy={setupBusy}
          onClose={afterChange}
          footer={
            setupEnabled ? undefined : (
              <>
                <Button variant="secondary" onClick={() => setDialog(null)} disabled={setupBusy}>
                  Cancel
                </Button>
                <Button type="submit" form="mfa-setup-form" disabled={setupBusy}>
                  {setupBusy ? "Verifying…" : "Turn on"}
                </Button>
              </>
            )
          }
        >
          <MfaSetupFlow
            account={account}
            formId="mfa-setup-form"
            onBusyChange={setSetupBusy}
            onEnabled={() => setSetupEnabled(true)}
            onDone={() => {
              setSetupEnabled(false);
              afterChange();
            }}
          />
        </Modal>
      )}
      {dialog === "disable" && <DisableMfaDialog onClose={() => setDialog(null)} onDone={afterChange} />}
      {dialog === "codes" && (
        <RegenerateCodesDialog
          account={account}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
