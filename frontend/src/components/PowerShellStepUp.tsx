import { FormEvent, useState } from "react";
import { Lock, ShieldCheck, Terminal as TerminalIcon, Timer } from "lucide-react";
import { createPowerShellSession, PowerShellStepUpError, type TerminalSession } from "../api/terminal";
import { Button, Modal } from "./ui";

/** What the operator is agreeing to, in three short lines. */
export const POWERSHELL_TERMS = [
  { icon: ShieldCheck, text: "Runs as SYSTEM, with full rights on the device" },
  { icon: Lock, text: "Everything the console shows is recorded" },
  { icon: Timer, text: "Closes after 15 min idle (60 min at most)" },
] as const;

export function stepUpMessage(err: unknown): string {
  if (err instanceof PowerShellStepUpError) {
    return err.code === "mfa_not_enabled"
      ? "Two-factor is off for your account. Turn it on in Settings → Security, then try again."
      : "Wrong or expired code. Enter the current code from your app.";
  }
  return err instanceof Error && err.message ? err.message : "Could not open PowerShell.";
}

/**
 * The two-factor step before an administrator PowerShell: asked every time,
 * whatever the operator's session says. Resolves with the new session.
 */
export function PowerShellCodeForm({
  deviceId,
  formId,
  onOpened,
  onBusy,
  showSubmit = true,
}: {
  deviceId: number;
  formId: string;
  onOpened: (session: TerminalSession) => void;
  onBusy?: (busy: boolean) => void;
  showSubmit?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    onBusy?.(true);
    setError(null);
    try {
      const session = await createPowerShellSession(deviceId, code);
      onOpened(session);
    } catch (err) {
      setError(stepUpMessage(err));
      setCode("");
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  return (
    <form id={formId} onSubmit={(e) => void submit(e)} className="space-y-4">
      <ul className="space-y-2">
        {POWERSHELL_TERMS.map(({ icon: Icon, text }) => (
          <li
            key={text}
            className="flex items-center gap-2.5 text-[13px]"
            style={{ color: "var(--th-text-secondary)" }}
          >
            <Icon className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
      <label className="block">
        <span className="premium-kicker mb-1.5 block">Two-factor code</span>
        <input
          data-autofocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label="Two-factor code"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${formId}-error` : undefined}
          className="th-input h-11 w-full rounded-lg border px-3 text-center font-mono text-[20px] tracking-[0.5em]"
        />
      </label>
      {error && (
        <p id={`${formId}-error`} role="alert" className="th-drawer-callout text-[13px]" data-tone="critical">
          {error}
        </p>
      )}
      {showSubmit && (
        <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
          <TerminalIcon className="h-4 w-4" />
          {busy ? "Checking…" : "Open PowerShell"}
        </Button>
      )}
    </form>
  );
}

/** The code form in the app's dialog, for the drawer. */
export function PowerShellOpenModal({
  deviceId,
  deviceName,
  onOpened,
  onClose,
}: {
  deviceId: number;
  deviceName: string;
  onOpened: (session: TerminalSession) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const formId = `ps-open-${deviceId}`;
  return (
    <Modal
      title="Open PowerShell as administrator"
      subtitle={deviceName}
      icon={TerminalIcon}
      tone="warning"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={busy}>
            {busy ? "Checking…" : "Open PowerShell"}
          </Button>
        </>
      }
    >
      <PowerShellCodeForm deviceId={deviceId} formId={formId} onOpened={onOpened} onBusy={setBusy} showSubmit={false} />
    </Modal>
  );
}
