import { useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Lock, UserRoundPen } from "lucide-react";

import { AuthUser, updateProfile } from "../api/auth";
import { PasswordField } from "./ChangePasswordModal";
import Button from "./ui/Button";
import Modal from "./ui/Modal";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Your own profile: the name shown across the console and your email.
 * Username and role are the account's identity and permissions, managed on
 * the Operators page; a new email asks for the current password.
 */
export default function EditProfileModal({
  user,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const trimmedName = displayName.trim();
  const trimmedEmail = email.trim();
  const nameChanged = trimmedName !== (user.display_name ?? "");
  const emailChanged = trimmedEmail.toLowerCase() !== (user.email ?? "").toLowerCase();
  const emailValid = EMAIL_PATTERN.test(trimmedEmail);
  const dirty = nameChanged || emailChanged;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dirty) {
      onClose();
      return;
    }
    if (trimmedName.length > 255) return setError("Display name is too long");
    if (emailChanged && !emailValid) return setError("Enter a valid email address");
    if (emailChanged && !password) return setError("Enter your current password to change your email");
    setBusy(true);
    setError(null);
    try {
      await updateProfile({
        ...(nameChanged ? { display_name: trimmedName || null } : {}),
        ...(emailChanged ? { email: trimmedEmail, current_password: password } : {}),
      });
      await onSaved();
      setSuccess(true);
      window.setTimeout(onClose, 1400);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Profile update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Edit profile"
      subtitle="How you appear to your team"
      icon={UserRoundPen}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        success ? undefined : (
          <>
            <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="edit-profile-form" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </>
        )
      }
    >
      {success ? (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-online)" } as CSSProperties}
          role="status"
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>Profile updated.</span>
        </div>
      ) : (
        <form id="edit-profile-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          {error && (
            <div
              className="th-onb-note th-onb-reveal"
              style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
              role="alert"
            >
              <AlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          <div className="th-profile-preview" aria-hidden="true">
            <span className="th-settings-avatar">{(trimmedName || user.username).charAt(0).toUpperCase()}</span>
            <span className="min-w-0">
              <strong key={trimmedName || user.username} className="th-share-count block truncate">
                {trimmedName || user.username}
              </strong>
              <small className="block truncate font-mono">{user.username}</small>
            </span>
          </div>
          <label className="th-onb-field">
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={user.username}
              maxLength={255}
              autoComplete="name"
              data-autofocus
            />
            <span className="th-onb-hint">Shown in the sidebar, activity and presence. Empty uses your username.</span>
          </label>
          <label className="th-onb-field">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              spellCheck={false}
              aria-invalid={emailChanged && !emailValid ? true : undefined}
            />
            {emailChanged && !emailValid && trimmedEmail && (
              <span className="th-onb-hint" style={{ color: "var(--th-status-critical)" }}>
                Not a valid email address
              </span>
            )}
          </label>
          {emailChanged && (
            <div className="th-onb-reveal">
              <PasswordField
                label="Current password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                hint="Needed to change your email."
              />
            </div>
          )}
          <div className="th-profile-locked">
            <Lock className="h-3.5 w-3.5 flex-none" />
            <span>
              Username <span className="font-mono">{user.username}</span> and role{" "}
              <span className="capitalize">{user.role}</span> are managed on the Operators page.
            </span>
          </div>
        </form>
      )}
    </Modal>
  );
}
