import { AlertTriangle, BadgeCheck, Info } from "lucide-react";

import type { Device } from "../api/devices";
import { timeAgo } from "../utils/time";

// The client reports every 15 s; older than this it is not "live" any more.
const LIVE_MS = 30 * 60 * 1000;

const spaced = (id: string) => id.replace(/(\d{3})(?=\d)/g, "$1 ");

/**
 * Where the Remote Support ID above comes from. Confirmed means TECHI Remote
 * Support itself reported this ID to the platform (the ID in its window);
 * otherwise it is what the agent read from configuration files.
 */
export default function RemoteSupportIdOrigin({
  device,
}: {
  device: Pick<
    Device,
    | "rustdesk_id"
    | "rustdesk_id_source"
    | "rustdesk_presence_at"
    | "agent_rustdesk_id"
    | "rustdesk_conflict_detected"
    | "rustdesk_sync_message"
    | "rustdesk_manual_override"
  >;
}) {
  if (!device.rustdesk_id) return null;
  const presence = device.rustdesk_presence_at ? new Date(device.rustdesk_presence_at).getTime() : null;
  const live = presence != null && Date.now() - presence <= LIVE_MS;
  const confirmed = device.rustdesk_id_source === "remote_support";
  const agentDisagrees =
    confirmed && Boolean(device.agent_rustdesk_id && device.agent_rustdesk_id !== device.rustdesk_id);

  if (device.rustdesk_conflict_detected && device.rustdesk_sync_message) {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12px]" style={{ color: "var(--th-status-critical)" }}>
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
        {device.rustdesk_sync_message}
      </p>
    );
  }
  return (
    <div className="mt-2 grid gap-1 text-[12px]">
      {confirmed && presence != null ? (
        <p
          className="flex items-center gap-1.5"
          style={{ color: live ? "var(--th-status-online)" : "var(--th-text-muted)" }}
        >
          <BadgeCheck className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          Confirmed by TECHI Remote Support ·{" "}
          {live
            ? `reported ${timeAgo(device.rustdesk_presence_at)}`
            : `last report ${timeAgo(device.rustdesk_presence_at)}`}
        </p>
      ) : device.rustdesk_manual_override ? (
        <p className="flex items-center gap-1.5" style={{ color: "var(--th-text-muted)" }}>
          <Info className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          Set by an operator (pinned)
        </p>
      ) : (
        <p className="flex items-center gap-1.5" style={{ color: "var(--th-text-muted)" }}>
          <Info className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          Read by the agent · not yet confirmed by Remote Support itself
        </p>
      )}
      {agentDisagrees && (
        <p className="flex items-start gap-1.5" style={{ color: "var(--th-status-warning)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
          The agent reads {spaced(device.agent_rustdesk_id!)} from an old configuration; the ID above is the one Remote
          Support itself reports.
        </p>
      )}
    </div>
  );
}
