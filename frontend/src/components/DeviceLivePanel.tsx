import React from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Network, User } from "lucide-react";
import { DeviceLive, LiveSnapshot } from "../hooks/useDeviceLive";
import { TONE } from "../utils/deviceStatus";

function usageTone(percent: number | undefined): string {
  if (percent == null) return TONE.neutral;
  if (percent >= 90) return TONE.critical;
  if (percent >= 75) return TONE.warning;
  return TONE.online;
}

function Meter({ percent }: { percent: number | undefined }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="th-onb-meter !h-1.5 !w-full" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
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

function formatUptime(seconds: number | undefined): string {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Tile({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail?: string;
  percent?: number;
}) {
  return (
    <div className="th-drawer-card !p-3">
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>
        {value}
      </div>
      {percent !== undefined && <Meter percent={percent} />}
      {detail && (
        <div className="mt-1 truncate text-[11px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
          {detail}
        </div>
      )}
    </div>
  );
}

function StatusLine({ live }: { live: DeviceLive }) {
  const text: Record<DeviceLive["state"], string> = {
    connecting: "Connecting…",
    waiting: "Waiting for the agent…",
    live: `Live · every ${live.intervalSeconds} s`,
    agent_offline: "Not available — the agent is offline or older than 2.1.27",
    unavailable: "Live view unavailable",
  };
  return (
    <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
      {live.state === "live" ? (
        <span className="sys-dot" aria-hidden="true" />
      ) : (
        <span
          className="inline-block h-2 w-2 rounded-full"
          aria-hidden="true"
          style={{ background: live.state === "waiting" || live.state === "connecting" ? TONE.stale : TONE.offline }}
        />
      )}
      {text[live.state]}
    </span>
  );
}

function Body({ snap, paused }: { snap: LiveSnapshot; paused: boolean }) {
  const disks = snap.disks ?? [];
  const processes = (snap.processes ?? []).slice(0, 8);
  return (
    <div style={{ opacity: paused ? 0.55 : 1 }} className="transition-opacity">
      <div className="grid grid-cols-2 gap-2">
        <Tile
          icon={Cpu}
          label="CPU"
          value={snap.cpu_percent != null ? `${Math.round(snap.cpu_percent)}%` : "—"}
          percent={snap.cpu_percent}
          detail={snap.process_count != null ? `${snap.process_count} processes` : undefined}
        />
        <Tile
          icon={MemoryStick}
          label="Memory"
          value={snap.ram_percent != null ? `${Math.round(snap.ram_percent)}%` : "—"}
          percent={snap.ram_percent}
          detail={`${formatGB(snap.ram_used_mb)} of ${formatGB(snap.ram_total_mb)}`}
        />
        <Tile
          icon={Network}
          label="Network"
          value={`↓ ${formatRate(snap.net_rx_kbps)}`}
          detail={`↑ ${formatRate(snap.net_tx_kbps)}`}
        />
        <Tile
          icon={User}
          label="Signed in"
          value={snap.current_user ? snap.current_user.split("\\").pop() ?? snap.current_user : "Nobody"}
          detail={`Up ${formatUptime(snap.uptime_seconds)}${snap.user_session_state ? ` · ${snap.user_session_state}` : ""}`}
        />
      </div>

      {disks.length > 0 && (
        <div className="th-drawer-card mt-2 !p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            <HardDrive className="h-3.5 w-3.5" />
            Disks
          </div>
          <div className="space-y-2">
            {disks.map((disk) => (
              <div key={disk.mount}>
                <div className="mb-1 flex items-baseline justify-between text-[12px] tabular-nums">
                  <span style={{ color: "var(--th-text-primary)" }}>{disk.mount}</span>
                  <span style={{ color: "var(--th-text-muted)" }}>
                    {disk.free_gb.toFixed(1)} GB free of {disk.total_gb.toFixed(0)} GB
                  </span>
                </div>
                <Meter percent={disk.used_percent} />
              </div>
            ))}
          </div>
        </div>
      )}

      {processes.length > 0 && (
        <div className="th-drawer-card mt-2 !p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            <Activity className="h-3.5 w-3.5" />
            Busiest processes
          </div>
          <table className="w-full text-[12px] tabular-nums">
            <thead>
              <tr style={{ color: "var(--th-text-muted)" }}>
                <th className="py-1 text-left font-normal">Name</th>
                <th className="py-1 text-right font-normal">CPU</th>
                <th className="py-1 text-right font-normal">Memory</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.pid} style={{ borderTop: "1px solid var(--th-border-subtle)" }}>
                  <td className="max-w-0 truncate py-1 pr-2" style={{ color: "var(--th-text-primary)" }} title={`${p.name} (PID ${p.pid})`}>
                    {p.name}
                  </td>
                  <td className="py-1 text-right" style={{ color: usageTone(p.cpu_percent >= 50 ? p.cpu_percent : undefined) }}>
                    {p.cpu_percent.toFixed(1)}%
                  </td>
                  <td className="py-1 text-right" style={{ color: "var(--th-text-secondary)" }}>
                    {p.memory_mb >= 1024 ? `${(p.memory_mb / 1024).toFixed(1)} GB` : `${Math.round(p.memory_mb)} MB`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Live CPU, memory, disks, network, signed-in user and busiest processes,
 *  streamed by the agent only while this panel is on screen. */
export default function DeviceLivePanel({ live }: { live: DeviceLive }) {
  return (
    <section className="mb-5" aria-label="Live">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="premium-kicker">Live</p>
        <StatusLine live={live} />
      </div>
      {live.snapshot ? (
        <Body snap={live.snapshot} paused={live.state !== "live"} />
      ) : live.state === "agent_offline" || live.state === "unavailable" ? null : (
        <div className="grid grid-cols-2 gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="th-drawer-card !p-3">
              <div className="h-3 w-12 rounded" style={{ background: "var(--th-ring-track)" }} />
              <div className="mt-2 h-5 w-16 rounded" style={{ background: "var(--th-ring-track)" }} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
