import React, { useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Network, User } from "lucide-react";
import type { ProcessInfo } from "../api/inventory";
import { DeviceLive, LiveSnapshot } from "../hooks/useDeviceLive";
import { useNow } from "../hooks/useNow";
import { TONE } from "../utils/deviceStatus";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import { SectionHeader } from "./ui";

/** What the last heartbeat said: the tiles' starting point when this session
 *  has no live frame for the device, and their values when it cannot stream. */
export interface HeartbeatValues {
  cpu_percent: number | null;
  ram_percent: number | null;
  disk_percent: number | null;
  uptime_seconds: number | null;
  current_user: string | null | undefined;
  at: string;
  /** From the device inventory, when it was loaded this session (no CPU column). */
  processes?: ProcessInfo[] | null;
}

/** Rows shown by default; the toggle shows the rest (a frame lists up to 10). */
export const TOP_PROCESSES = 5;
const MAX_PROCESSES = 10;

interface ProcessRow {
  key: string;
  name: string;
  pid: number;
  cpu: number | null;
  memoryMb: number | null;
}

/** The values on screen, wherever they came from. */
interface Shown {
  snap: LiveSnapshot;
  processes: ProcessRow[];
  /** When they were true (ISO). */
  at: string;
  source: "live" | "heartbeat";
}

function fromHeartbeat(values: HeartbeatValues): Shown {
  const processes = [...(values.processes ?? [])]
    .sort((a, b) => (b.memory_mb ?? 0) - (a.memory_mb ?? 0))
    .slice(0, MAX_PROCESSES)
    .map((p) => ({ key: `${p.pid}`, name: p.name, pid: p.pid, cpu: null, memoryMb: p.memory_mb ?? null }));
  return {
    snap: {
      cpu_percent: values.cpu_percent ?? undefined,
      ram_percent: values.ram_percent ?? undefined,
      disks:
        values.disk_percent != null
          ? [{ mount: "System disk", used_percent: values.disk_percent, free_gb: 0, total_gb: 0 }]
          : [],
      uptime_seconds: values.uptime_seconds ?? undefined,
      current_user: values.current_user ?? undefined,
    },
    processes,
    at: values.at,
    source: "heartbeat",
  };
}

function fromFrame(snap: LiveSnapshot, receivedAt: number | null): Shown {
  return {
    snap,
    processes: (snap.processes ?? []).slice(0, MAX_PROCESSES).map((p) => ({
      key: `${p.pid}`,
      name: p.name,
      pid: p.pid,
      cpu: p.cpu_percent,
      memoryMb: p.memory_mb,
    })),
    at: new Date(receivedAt ?? Date.now()).toISOString(),
    source: "live",
  };
}

function usageTone(percent: number | undefined): string {
  if (percent == null) return TONE.neutral;
  if (percent >= 90) return TONE.critical;
  if (percent >= 75) return TONE.warning;
  return TONE.online;
}

function Meter({ percent }: { percent: number | undefined }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div
      className="th-onb-meter !h-1.5 !w-full"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i
        className="transition-[width] duration-700"
        style={{ width: `${value}%`, "--meter-tone": usageTone(percent) } as React.CSSProperties}
      />
    </div>
  );
}

function formatRate(kbps: number | undefined): string {
  if (kbps == null) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mb/s`;
  return `${Math.round(kbps)} kb/s`;
}

function formatGB(mb: number | undefined): string {
  if (mb == null) return "—";
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatMemory(mb: number | null): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatUptime(seconds: number | undefined): string {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Bar({ width }: { width: number }) {
  return <span className="th-live-skel" style={{ width }} aria-hidden="true" />;
}

/** Fixed height whatever it holds: values change in place, nothing moves. */
function Tile({
  icon: Icon,
  label,
  value,
  detail,
  percent,
  meter = false,
  loading = false,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail?: string;
  percent?: number;
  meter?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="th-live-tile" data-testid={`live-tile-${label}`}>
      <span className="th-live-tile-label">
        <Icon aria-hidden="true" />
        {label}
      </span>
      <span className="th-live-tile-value">{loading ? <Bar width={56} /> : value}</span>
      <span className="th-live-tile-meter">{meter && !loading && <Meter percent={percent} />}</span>
      <span className="th-live-tile-detail">{loading ? <Bar width={80} /> : (detail ?? "")}</span>
    </div>
  );
}

function Disks({ shown }: { shown: Shown | null }) {
  const disks = shown?.snap.disks ?? [];
  return (
    <div className="th-live-card">
      <div className="th-live-card-head">
        <span>
          <HardDrive aria-hidden="true" />
          Disks
        </span>
        {disks.length > 1 && <small>{disks.length} volumes</small>}
      </div>
      {!shown ? (
        <div className="space-y-3" aria-hidden="true">
          <Bar width={120} />
          <Bar width={120} />
        </div>
      ) : disks.length === 0 ? (
        <p className="th-live-empty">Not reported yet.</p>
      ) : (
        <div className="space-y-2.5">
          {disks.map((disk) => (
            <div key={disk.mount}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px] tabular-nums">
                <span style={{ color: "var(--th-text-primary)" }}>{disk.mount}</span>
                <span className="truncate" style={{ color: "var(--th-text-muted)" }}>
                  {disk.total_gb > 0
                    ? `${disk.free_gb.toFixed(1)} GB free of ${disk.total_gb.toFixed(0)} GB`
                    : `${Math.round(disk.used_percent)}% used`}
                </span>
              </div>
              <Meter percent={disk.used_percent} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Processes({ shown, waitingText }: { shown: Shown | null; waitingText: string }) {
  const [showAll, setShowAll] = useState(false);
  const rows = shown?.processes ?? [];
  const visible = showAll ? rows : rows.slice(0, TOP_PROCESSES);
  const byMemory = shown?.source === "heartbeat";
  return (
    <div className="th-live-card" aria-label="Busiest processes" role="group">
      <div className="th-live-card-head">
        <span>
          <Activity aria-hidden="true" />
          Busiest processes
        </span>
        {rows.length > TOP_PROCESSES && (
          <button
            type="button"
            className="th-link-btn !h-6 !min-h-0 !px-1 !py-0 text-[12px]"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? `Show top ${TOP_PROCESSES}` : `Show all ${rows.length}`}
          </button>
        )}
      </div>
      <div className="th-live-procs">
        {!shown ? (
          <div className="space-y-2.5 pt-1" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <Bar key={i} width={140 - i * 12} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="th-live-empty">{waitingText}</p>
        ) : (
          <table className="th-live-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">CPU</th>
                <th scope="col">Memory</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.key}>
                  <td title={`${p.name} (PID ${p.pid})`}>{p.name}</td>
                  <td
                    style={{
                      color: p.cpu != null && p.cpu >= 50 ? usageTone(p.cpu) : "var(--th-text-secondary)",
                    }}
                  >
                    {p.cpu != null ? `${p.cpu.toFixed(1)}%` : "—"}
                  </td>
                  <td>{formatMemory(p.memoryMb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {byMemory && rows.length > 0 && <p className="th-live-foot">From the inventory · by memory</p>}
    </div>
  );
}

type Mode = "live" | "starting" | "paused" | "static";

function agoText(iso: string): string {
  const ago = timeAgo(iso);
  return ago === "just now" ? "a moment ago" : ago;
}

/**
 * The device's current state in one place: CPU, memory, network and the
 * signed-in user as four fixed tiles, then disks and the busiest processes.
 *
 * Never blank: the tiles start from this session's last live frame for the
 * device (the hook seeds it), else the last heartbeat, and show skeletons
 * only when neither exists. When the stream stops the last values stay,
 * dimmed and labelled "Paused · last at HH:MM"; frames update them in place.
 */
export default function DeviceLivePanel({
  live,
  fallback = null,
  liveCapable = true,
}: {
  live: DeviceLive;
  fallback?: HeartbeatValues | null;
  liveCapable?: boolean;
}) {
  useNow(); // the ages in the header follow the clock
  const frame = liveCapable && live.snapshot ? fromFrame(live.snapshot, live.receivedAt) : null;
  const heartbeat = fallback ? fromHeartbeat(fallback) : null;
  // Until this subscription streams, the newer of the cached frame and the
  // last heartbeat wins: an old cached frame never hides a fresher heartbeat.
  const cachedIsOlder =
    frame !== null && heartbeat !== null && live.state !== "live" && Date.parse(frame.at) < Date.parse(heartbeat.at);
  const shown: Shown | null = cachedIsOlder ? heartbeat : (frame ?? heartbeat);
  // A heartbeat's process list (inventory) is better than none while live has none.
  if (frame && shown === frame && frame.processes.length === 0 && fallback?.processes?.length) {
    frame.processes = fromHeartbeat(fallback).processes;
  }

  const mode: Mode = !liveCapable
    ? "static"
    : live.state === "live" && live.snapshot
      ? "live"
      : live.active && (live.state === "connecting" || live.state === "waiting")
        ? "starting"
        : "paused";

  let meta: string;
  let note: string | null = null;
  if (!liveCapable) {
    meta = shown ? `From the last heartbeat · ${agoText(shown.at)}` : "No data yet";
    note = "Live view not available for this device.";
  } else if (mode === "live") {
    meta = `Live · every ${live.intervalSeconds} s`;
  } else if (mode === "starting") {
    meta = shown ? `From ${agoText(shown.at)} · connecting…` : "Connecting…";
  } else {
    meta = shown
      ? `Paused · last at ${formatLocalDateTime(shown.at, { hour: "2-digit", minute: "2-digit" })}`
      : live.state === "unavailable"
        ? "Live view unavailable"
        : "Paused";
    if (live.state === "agent_offline") note = "Not available — the agent is offline or older than 2.1.27.";
    else if (live.state === "unavailable") note = "Live view unavailable.";
  }

  const dot =
    mode === "live" ? (
      <span className="sys-dot" aria-hidden="true" />
    ) : (
      <span
        className="inline-block h-2 w-2 flex-none rounded-full"
        aria-hidden="true"
        style={{ background: mode === "starting" ? TONE.stale : TONE.offline }}
      />
    );

  const snap = shown?.snap;
  const loading = !shown;
  const waitingText =
    mode === "live" || mode === "starting"
      ? "Listed with the first live frame."
      : "No process list yet. It arrives with the live view.";

  return (
    <section className="mb-3.5" aria-label="Live" data-live-mode={mode} data-live-source={shown?.source ?? "none"}>
      <SectionHeader
        title={liveCapable ? "Live" : "Latest"}
        meta={
          <>
            {dot}
            <span className="truncate" data-testid="live-status">
              {meta}
            </span>
          </>
        }
        metaTitle={shown ? `Values from ${formatLocalDateTime(shown.at)}` : undefined}
      />
      <div className="th-live" data-mode={mode} aria-busy={loading || undefined}>
        <div className="th-live-tiles">
          <Tile
            icon={Cpu}
            label="CPU"
            meter
            loading={loading}
            value={snap?.cpu_percent != null ? `${Math.round(snap.cpu_percent)}%` : "—"}
            percent={snap?.cpu_percent}
            detail={snap?.process_count != null ? `${snap.process_count} processes` : "Processor load"}
          />
          <Tile
            icon={MemoryStick}
            label="Memory"
            meter
            loading={loading}
            value={snap?.ram_percent != null ? `${Math.round(snap.ram_percent)}%` : "—"}
            percent={snap?.ram_percent}
            detail={
              snap?.ram_total_mb != null ? `${formatGB(snap.ram_used_mb)} of ${formatGB(snap.ram_total_mb)}` : "In use"
            }
          />
          <Tile
            icon={Network}
            label="Network"
            loading={loading}
            value={`↓ ${formatRate(snap?.net_rx_kbps)}`}
            detail={`↑ ${formatRate(snap?.net_tx_kbps)}`}
          />
          <Tile
            icon={User}
            label="Signed in"
            loading={loading}
            value={snap?.current_user ? (snap.current_user.split("\\").pop() ?? snap.current_user) : "Nobody"}
            detail={`Up ${formatUptime(snap?.uptime_seconds)}${snap?.user_session_state ? ` · ${snap.user_session_state}` : ""}`}
          />
        </div>
        <div className="th-live-split">
          <Disks shown={shown} />
          <Processes shown={shown} waitingText={waitingText} />
        </div>
      </div>
      {note && <p className="th-live-note">{note}</p>}
    </section>
  );
}
