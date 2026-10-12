import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, KeyRound, RefreshCw } from "lucide-react";
import {
  getRemoteSupportPasswordStatus,
  RemoteSupportPasswordStatus,
  rotateAllRemoteSupportPasswords,
} from "../../api/remoteSupport";
import { formatLocalDateTime } from "../../utils/time";
import { formatCount } from "../../utils/number";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { CardHead } from "../ui/PanelCard";

const TONE_OK = "var(--th-status-online)";
const devices = (n: number) => `${formatCount(n)} device${n === 1 ? "" : "s"}`;
const TONE_WARN = "var(--th-status-warning)";

/**
 * Owner/admin: the fleet's Remote Support (RustDesk) passwords — unique per
 * device, rotated on a schedule, and "rotate all" for when someone with
 * access leaves. Connect keeps working through a rotation: the server uses a
 * device's previous password until its next heartbeat delivers the new one.
 */
export default function RemoteSupportPasswordsCard({ style }: { style?: CSSProperties }) {
  const [status, setStatus] = useState<RemoteSupportPasswordStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getRemoteSupportPasswordStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the password status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async () => {
    setBusy(true);
    try {
      const { rotated } = await rotateAllRemoteSupportPasswords();
      setResult(rotated);
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rotation failed.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const legacy = status?.legacy_shared ?? 0;

  return (
    <div className="th-onb-card th-onb-enter" style={style}>
      <CardHead
        icon={KeyRound}
        tone={legacy > 0 ? TONE_WARN : TONE_OK}
        title="Remote Support passwords"
        subtitle="Unique per device and replaced automatically"
      />
      <div className="th-onb-body flex flex-col gap-4">
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
        <dl className="th-dl">
          <dt>Rotation</dt>
          <dd>
            {!status
              ? "…"
              : status.rotation_days > 0
                ? `Every ${status.rotation_days} days, at night`
                : "Off — passwords change only when rotated by hand"}
          </dd>
          <dt>Own password</dt>
          <dd className="tabular-nums">{status ? devices(status.per_device) : "…"}</dd>
          <dt>Old shared one</dt>
          <dd className="tabular-nums" style={legacy > 0 ? { color: TONE_WARN } : undefined}>
            {!status ? "…" : legacy > 0 ? `${devices(legacy)} — their agent is too old; update it` : "None"}
          </dd>
          <dt>Oldest password</dt>
          <dd className="tabular-nums">
            {status?.oldest_changed_at
              ? formatLocalDateTime(status.oldest_changed_at, { day: "numeric", month: "short", year: "numeric" })
              : "—"}
          </dd>
        </dl>
        {result !== null && (
          <div className="th-onb-note" style={{ "--onb-tone": TONE_OK } as CSSProperties} role="status">
            <KeyRound className="h-4 w-4" />
            <span>
              New passwords for {devices(result)}. Each takes effect on its next heartbeat (within about 5 minutes);
              Connect keeps working meanwhile.
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            Rotate them all when someone who could connect leaves the team.
          </p>
          <Button variant="secondary" size="sm" className="flex-none" onClick={() => setConfirming(true)}>
            <RefreshCw className="h-3.5 w-3.5" /> Rotate all now
          </Button>
        </div>
      </div>

      {confirming && (
        <Modal
          title="Rotate every Remote Support password?"
          subtitle="Applied by each device on its next heartbeat"
          icon={KeyRound}
          size="md"
          busy={busy}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void rotate()} disabled={busy}>
                {busy ? "Rotating…" : `Rotate ${status ? formatCount(status.per_device) : ""} passwords`}
              </Button>
            </>
          }
        >
          <ul className="list-disc space-y-1.5 pl-5 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
            <li>Every device gets a new unique password; anyone who knew an old one can no longer use it.</li>
            <li>Connect from the console keeps working throughout.</li>
            <li>A Remote Support session open right now drops when its device applies the new password.</li>
            {legacy > 0 && <li>{devices(legacy)} on an old agent keep the shared password until updated.</li>}
          </ul>
        </Modal>
      )}
    </div>
  );
}
