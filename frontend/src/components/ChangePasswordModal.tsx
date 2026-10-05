import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import { changePassword } from "../api/auth";

interface ChangePasswordModalProps {
  onClose: () => void;
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const validate = (): string | null => {
    if (!current) return "Current password is required";
    if (!next) return "New password is required";
    if (next.length < 8) return "New password must be at least 8 characters";
    if (next !== confirm) return "Passwords do not match";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setSuccess(true);
      setTimeout(onClose, 1800);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Password change failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl shadow-2xl"
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: "color-mix(in srgb, var(--th-accent) 12%, transparent)" }}>
              <KeyRound className="h-4 w-4" style={{ color: "var(--th-accent)" }} />
            </div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
              Change Password
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 transition hover:bg-white/[0.06]"
            style={{ color: "var(--th-text-muted)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {success ? (
            <div className="rounded-lg px-4 py-3 text-sm font-medium text-center"
              style={{ background: "color-mix(in srgb, var(--th-status-online) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-online) 25%, transparent)", color: "var(--th-status-online)" }}>
              Password changed successfully
            </div>
          ) : (
            <>
              {error && (
                <div className="rounded-lg px-3 py-2 text-xs font-medium"
                  style={{ background: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-critical) 25%, transparent)", color: "var(--th-status-critical)" }}>
                  {error}
                </div>
              )}

              {/* Current password */}
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--th-text-muted)" }}>
                  Current Password
                </span>
                <div className="relative">
                  <input
                    ref={firstRef}
                    type={showCurrent ? "text" : "password"}
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    autoComplete="current-password"
                    className="w-full rounded-lg border pr-9 px-3 py-2 text-sm font-medium outline-none transition"
                    style={{
                      background: "var(--th-bg-input, color-mix(in srgb, var(--th-text-primary) 4%, transparent))",
                      border: "1px solid var(--th-border-input)",
                      color: "var(--th-text-primary)",
                    }}
                  />
                  <button type="button" tabIndex={-1}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2"
                    style={{ color: "var(--th-text-muted)" }}
                    onClick={() => setShowCurrent(v => !v)}>
                    {showCurrent ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </label>

              {/* New password */}
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--th-text-muted)" }}>
                  New Password
                </span>
                <div className="relative">
                  <input
                    type={showNext ? "text" : "password"}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    autoComplete="new-password"
                    className="w-full rounded-lg border px-3 py-2 pr-9 text-sm font-medium outline-none transition"
                    style={{
                      background: "var(--th-bg-input, color-mix(in srgb, var(--th-text-primary) 4%, transparent))",
                      border: "1px solid var(--th-border-input)",
                      color: "var(--th-text-primary)",
                    }}
                  />
                  <button type="button" tabIndex={-1}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2"
                    style={{ color: "var(--th-text-muted)" }}
                    onClick={() => setShowNext(v => !v)}>
                    {showNext ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {next && next.length < 8 && (
                  <p className="mt-1 text-[10px]" style={{ color: "var(--th-accent)" }}>
                    Minimum 8 characters
                  </p>
                )}
              </label>

              {/* Confirm */}
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--th-text-muted)" }}>
                  Confirm New Password
                </span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border px-3 py-2 text-sm font-medium outline-none transition"
                  style={{
                    background: "var(--th-bg-input, color-mix(in srgb, var(--th-text-primary) 4%, transparent))",
                    border: confirm && confirm !== next
                      ? "1px solid color-mix(in srgb, var(--th-status-critical) 50%, transparent)"
                      : "1px solid var(--th-border-input)",
                    color: "var(--th-text-primary)",
                  }}
                />
              </label>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                  style={{
                    background: "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
                    border: "1px solid var(--th-border-subtle)",
                    color: "var(--th-text-secondary)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg px-4 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: "color-mix(in srgb, var(--th-accent) 18%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--th-accent) 35%, transparent)",
                    color: "var(--th-accent)",
                  }}
                >
                  {busy ? "Saving…" : "Change Password"}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </>
  );
}
