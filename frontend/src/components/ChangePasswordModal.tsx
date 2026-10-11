import { useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound } from "lucide-react";
import { changePassword } from "../api/auth";
import Button from "./ui/Button";
import Modal from "./ui/Modal";

interface ChangePasswordModalProps {
  onClose: () => void;
}

function PasswordField({ label, value, onChange, autoComplete, invalid, hint, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; hint?: string; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <label className="th-onb-field">
      {label}
      <span className="th-onb-pw" data-invalid={invalid || undefined}>
        <input type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} data-autofocus={autoFocus || undefined} />
        <button type="button" tabIndex={-1} onClick={() => setShown((v) => !v)} aria-label={shown ? "Hide password" : "Show password"}>
          {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </span>
      {hint && <span className="th-onb-hint" style={invalid ? { color: "var(--th-status-critical)" } : undefined}>{hint}</span>}
    </label>
  );
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const validate = (): string | null => {
    if (!current) return "Current password is required";
    if (!next) return "New password is required";
    if (next.length < 8) return "New password must be at least 8 characters";
    if (next !== confirm) return "Passwords do not match";
    return null;
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setSuccess(true);
      setTimeout(onClose, 1800);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change password"
      subtitle="For your own account"
      icon={KeyRound}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={success ? undefined : (
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="change-password-form" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button>
        </>
      )}
    >
      {success ? (
        <div className="th-onb-note th-onb-reveal" style={{ "--onb-tone": "var(--th-status-online)" } as CSSProperties} role="status">
          <CheckCircle2 className="h-4 w-4" />
          <span>Password changed.</span>
        </div>
      ) : (
        <form id="change-password-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          {error && (
            <div className="th-onb-note th-onb-reveal" style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties} role="alert">
              <AlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
          <PasswordField label="New password" value={next} onChange={setNext} autoComplete="new-password" invalid={!!next && next.length < 8} hint={next && next.length < 8 ? "At least 8 characters" : undefined} />
          <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={!!confirm && confirm !== next} hint={confirm && confirm !== next ? "Does not match" : undefined} />
        </form>
      )}
    </Modal>
  );
}
