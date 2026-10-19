import { useEffect, useState } from "react";
import { ShieldOff } from "lucide-react";

import { allowRevokedAgent, getRevokedAgents, type RevokedAgent } from "../api/devices";
import { timeAgo } from "../utils/time";
import ConfirmationModal from "./ConfirmationModal";
import Button from "./ui/Button";

/**
 * Shown in the Trash view: agents of devices already purged, which the
 * platform still refuses. "Allow back" lets one in again; its next heartbeat
 * creates the device anew. Devices still in the trash are restored from the
 * table instead.
 */
export default function RevokedAgentsPanel() {
  const [agents, setAgents] = useState<RevokedAgent[]>([]);
  const [pending, setPending] = useState<RevokedAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getRevokedAgents()
      .then((rows) => setAgents(rows.filter((row) => !row.device_exists)))
      .catch(() => setAgents([]));

  useEffect(() => {
    void load();
  }, []);

  if (agents.length === 0) return null;

  const allow = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await allowRevokedAgent(pending.id);
      setPending(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not allow the agent back.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="premium-card p-4" aria-labelledby="revoked-agents-title">
      <div className="mb-3 flex items-center gap-2">
        <ShieldOff className="h-4 w-4" style={{ color: "var(--th-text-muted)" }} aria-hidden="true" />
        <h2 id="revoked-agents-title" className="text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
          Blocked agents of deleted devices
        </h2>
        <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          Refused until allowed back
        </span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--th-border)" }}>
        {agents.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-[13px]">
            <span className="min-w-[140px] font-medium" style={{ color: "var(--th-text-primary)" }}>
              {agent.hostname || `Device #${agent.device_id ?? "?"}`}
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--th-text-secondary)" }}>
              {agent.reason || "—"}
            </span>
            <span style={{ color: "var(--th-text-muted)" }}>
              {agent.last_attempt_at ? `Last tried ${timeAgo(agent.last_attempt_at)}` : "Not seen since"}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setPending(agent)}>
              Allow back
            </Button>
          </li>
        ))}
      </ul>
      {pending && (
        <ConfirmationModal
          title="Allow agent back"
          confirmLabel="Allow back"
          destructive={false}
          loading={busy}
          onClose={() => setPending(null)}
          onConfirm={() => void allow()}
        >
          <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
            {pending.hostname || `Device #${pending.device_id ?? "?"}`}
          </p>
          <p className="mt-3">
            Its next heartbeat creates the device again, without history and without a client until it is placed.
          </p>
          {error && (
            <p role="alert" className="th-drawer-callout mt-3 text-[13px]" data-tone="critical">
              {error}
            </p>
          )}
        </ConfirmationModal>
      )}
    </section>
  );
}
