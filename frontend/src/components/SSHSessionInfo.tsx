import { useEffect, useState } from "react";

import { getSshSessionDetail, type SSHSessionDetail } from "../api/terminal";
import { parseUTC } from "../utils/time";

// Embedded SSH Connect session info bar: device, client, operator, username,
// authentication source, start, duration, idle timer, status — polls the
// session detail endpoint (cheap, DB + in-memory relay read) every few
// seconds while the Terminal tab / modal is open.

interface Props {
  deviceId: number;
  sessionId: string;
}

const SOURCE_LABELS: Record<string, string> = {
  device: "Device",
  group: "Group",
  client: "Client",
  global: "Global",
  temporary: "Temporary Session",
};

const POLL_INTERVAL_MS = 5000;

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

export default function SSHSessionInfo({ deviceId, sessionId }: Props) {
  const [detail, setDetail] = useState<SSHSessionDetail | null>(null);
  const [fetchedAtMs, setFetchedAtMs] = useState<number>(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => {
      getSshSessionDetail(deviceId, sessionId)
        .then((d) => {
          if (!active) return;
          setDetail(d);
          setFetchedAtMs(Date.now());
        })
        .catch(() => { /* keep showing the last known detail */ });
    };
    load();
    const poll = window.setInterval(load, POLL_INTERVAL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [deviceId, sessionId]);

  if (!detail) return null;

  const startedAtMs = detail.started_at ? parseUTC(detail.started_at).getTime() : null;
  const elapsedSincePollSeconds = (now - fetchedAtMs) / 1000;
  const durationSeconds =
    detail.status === "active" && startedAtMs ? (now - startedAtMs) / 1000 : detail.duration_seconds;
  const idleSeconds =
    detail.status === "active" && detail.idle_seconds !== null
      ? detail.idle_seconds + elapsedSincePollSeconds
      : null;

  const field = (label: string, value: string | number | null | undefined) =>
    value === null || value === undefined || value === "" ? null : (
      <span>
        <span style={{ color: "var(--th-text-faint)" }}>{label}: </span>
        {value}
      </span>
    );

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-2 text-[11px]"
      style={{
        background: "var(--th-bg-drawer-section)",
        border: "1px solid var(--th-border-drawer-section)",
        color: "var(--th-text-secondary)",
      }}
    >
      {field("Device", detail.device_hostname || `#${detail.device_id}`)}
      {field("Client", detail.client_name)}
      {field("Operator", detail.operator_username || "—")}
      {field("Username", detail.ssh_username || "—")}
      {field("Authentication", SOURCE_LABELS[detail.credential_source || ""] || detail.credential_source || "—")}
      {field("Status", detail.status)}
      {detail.status === "active" && field("Duration", formatClock(durationSeconds))}
      {detail.status === "active" && idleSeconds !== null && field("Idle", formatClock(idleSeconds))}
    </div>
  );
}
