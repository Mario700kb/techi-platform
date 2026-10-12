import { FormEvent, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { enableMfa, MfaSetup, startMfaSetup } from "../../api/auth";
import Button from "../ui/Button";
import QrCode from "./QrCode";
import RecoveryCodes from "./RecoveryCodes";

/** Groups a base32 secret in fours so it can be typed into an app by hand. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Two-factor setup: scan → confirm a code → save recovery codes. Used in
 * Settings (inside a dialog) and on the enrolment screen a required role sees.
 * `onDone` runs after the operator has seen their recovery codes.
 */
export default function MfaSetupFlow({
  account,
  onDone,
  formId,
  onBusyChange,
  onEnabled,
  inlineSubmit = false,
}: {
  account: string;
  onDone: () => void;
  /** Lets a surrounding dialog's footer button submit the code form. */
  formId: string;
  onBusyChange?: (busy: boolean) => void;
  /** MFA is now on and the recovery codes are showing (a dialog hides its submit button). */
  onEnabled?: () => void;
  /** Render the confirm button inside the form instead of in a dialog footer. */
  inlineSubmit?: boolean;
}) {
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    startMfaSetup()
      .then((result) => {
        if (active) setSetup(result);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Could not start the setup");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      setCodes(await enableMfa(code));
      onEnabled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn on two-factor authentication");
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the key stays visible.
    }
  };

  if (codes) {
    return (
      <div className="flex flex-col gap-4">
        <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-online)" } as CSSProperties} role="status">
          <Check className="h-4 w-4" />
          <span>Two-factor authentication is on. Your other signed-in browsers were signed out.</span>
        </div>
        <RecoveryCodes codes={codes} account={account} />
        <div className="flex justify-end">
          <Button onClick={onDone}>I saved my recovery codes</Button>
        </div>
      </div>
    );
  }

  return (
    <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error && (
        <div
          className="th-onb-note"
          style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}
      <ol className="flex flex-col gap-4 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
        <li>
          <strong style={{ color: "var(--th-text-primary)" }}>1. Scan with your authenticator app</strong>
          <span className="block">Microsoft Authenticator, Google Authenticator, 1Password or any TOTP app.</span>
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {setup ? (
              <QrCode value={setup.otpauth_uri} label="QR code for your authenticator app" />
            ) : (
              <span
                className="th-alerts-skeleton !m-0 block rounded-lg"
                style={{ width: 184, height: 184 }}
                aria-busy="true"
                aria-label="Preparing the QR code"
              />
            )}
            {setup && (
              <div className="min-w-0">
                <span className="block text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  Can't scan? Enter this key instead:
                </span>
                <code
                  className="mt-1 block break-all font-mono text-[13px]"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {groupSecret(setup.secret)}
                </code>
                <button type="button" className="th-link-btn -ml-2 mt-1 gap-1" onClick={() => void copySecret()}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy key"}
                </button>
              </div>
            )}
          </div>
        </li>
        <li>
          <label className="th-onb-field">
            <strong style={{ color: "var(--th-text-primary)" }}>2. Enter the 6-digit code it shows</strong>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="max-w-[180px] font-mono tracking-[0.3em]"
              disabled={!setup || busy}
            />
          </label>
        </li>
      </ol>
      {inlineSubmit && (
        <div className="flex justify-end">
          <Button type="submit" disabled={!setup || busy || code.length !== 6}>
            {busy ? "Verifying…" : "Turn on two-factor authentication"}
          </Button>
        </div>
      )}
    </form>
  );
}
