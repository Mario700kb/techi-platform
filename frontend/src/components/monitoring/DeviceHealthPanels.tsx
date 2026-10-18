import React from "react";
import type { LucideIcon } from "lucide-react";
import { AlertOctagon, Disc3, HeartPulse, ListOrdered, Power, RotateCw, Thermometer } from "lucide-react";

import {
  formatDuration,
  type CoverageSegment,
  type DeviceHealth,
  type HealthEvent,
  type MetricsRange,
  type PhysicalDisk,
  type ProcessPeak,
} from "../../api/monitoring";
import { formatLocalDateTime, parseUTC, timeAgo } from "../../utils/time";
import { AVAILABILITY_KINDS, AvailabilityStrip, availabilityKind } from "../MetricCharts";

// The Monitoring tab's cards that read the 2.1.33 agent's reports: when the
// device was on, which processes were busiest, how its physical disks are,
// whether a restart is waiting and which critical events Windows logged.

export function MonitoringPanel({
  title,
  icon: Icon,
  aside,
  children,
  label,
}: {
  title: string;
  icon?: LucideIcon;
  aside?: React.ReactNode;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <section className="th-drawer-card mb-3" aria-label={label ?? title}>
      <div className="mb-3 flex min-h-[20px] items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
          {Icon && <Icon className="h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} aria-hidden="true" />}
          {title}
        </h3>
        {aside && (
          <div
            className="min-w-0 truncate text-right text-[12px] tabular-nums"
            style={{ color: "var(--th-text-muted)" }}
          >
            {aside}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

export function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 text-[11px]" style={{ color: "var(--th-text-faint)" }}>
      {children}
    </p>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
      {children}
    </p>
  );
}

const HEALTH_TONE: Record<string, string> = {
  healthy: "var(--th-status-online)",
  warning: "var(--th-status-warning)",
  unhealthy: "var(--th-status-critical)",
  unknown: "var(--th-text-faint)",
};
const HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthy",
  warning: "Warning",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="th-status-chip !h-6 flex-none" style={{ "--chip-tone": tone } as React.CSSProperties}>
      <i />
      {children}
    </span>
  );
}

// ── Availability ────────────────────────────────────────────────────────────

/** Minutes of each kind inside the range. */
export function availabilityTotals(segments: CoverageSegment[], start: string, end: string) {
  const t0 = parseUTC(start).getTime();
  const t1 = parseUTC(end).getTime();
  const totals = { on: 0, off: 0, missing: 0 };
  for (const seg of segments) {
    const a = Math.max(t0, parseUTC(seg.start).getTime());
    const b = Math.min(t1, parseUTC(seg.end).getTime());
    if (b > a) totals[availabilityKind(seg.kind)] += (b - a) / 1000;
  }
  return totals;
}

export function AvailabilityPanel({
  segments,
  restarts,
  start,
  end,
}: {
  segments: CoverageSegment[];
  restarts: string[];
  start: string;
  end: string;
}) {
  const totals = availabilityTotals(segments, start, end);
  const n = restarts.length;
  return (
    <MonitoringPanel
      title="Availability"
      icon={Power}
      aside={n ? `${n} restart${n === 1 ? "" : "s"} · last ${timeAgo(restarts[n - 1])}` : "no restart in range"}
    >
      <AvailabilityStrip segments={segments} restarts={restarts} start={start} end={end} />
      <dl className="mt-3 grid grid-cols-3 gap-x-4 text-[12px] tabular-nums" style={{ paddingLeft: 48 }}>
        {AVAILABILITY_KINDS.map((k) => (
          <div key={k.key} className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5" style={{ color: "var(--th-text-muted)" }}>
              <i
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: k.tone, boxShadow: "inset 0 0 0 1px var(--th-border-subtle)" }}
              />
              {k.label}
            </dt>
            <dd style={{ color: "var(--th-text-primary)" }}>
              {totals[k.key] >= 60 ? formatDuration(Math.round(totals[k.key])) : "—"}
            </dd>
          </div>
        ))}
      </dl>
    </MonitoringPanel>
  );
}

// ── Top processes ───────────────────────────────────────────────────────────

function formatMB(mb: number | null): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function TopProcessesPanel({ processes, range }: { processes: ProcessPeak[]; range: MetricsRange }) {
  const short = range === "1h" || range === "24h";
  const timeOpts: Intl.DateTimeFormatOptions | undefined = short ? { hour: "2-digit", minute: "2-digit" } : undefined;
  return (
    <MonitoringPanel title="Busiest processes" icon={ListOrdered} aside="when CPU ≥ 15% or memory ≥ 80%">
      {processes.length === 0 ? (
        <Muted>No busy minute in this range — nothing to blame.</Muted>
      ) : (
        <table className="w-full table-fixed text-[13px] tabular-nums" data-testid="top-processes">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--th-text-faint)" }}>
              <th className="pb-1.5 font-medium">Process</th>
              <th className="w-[132px] pb-1.5 text-right font-medium">Peak CPU</th>
              <th className="w-[92px] pb-1.5 text-right font-medium">Peak memory</th>
              <th className="w-[84px] pb-1.5 text-right font-medium">{short ? "Minutes" : "Points"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--th-border-drawer-section)]">
            {processes.map((p) => (
              <tr key={p.name}>
                <td className="truncate py-2 font-medium" style={{ color: "var(--th-text-primary)" }} title={p.name}>
                  {p.name}
                </td>
                <td className="py-2 text-right" style={{ color: "var(--th-text-secondary)" }}>
                  {p.cpu_peak != null ? `${Math.round(p.cpu_peak)}%` : "—"}
                  {p.cpu_peak_at && (
                    <span className="ml-1.5 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                      {formatLocalDateTime(p.cpu_peak_at, timeOpts)}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right" style={{ color: "var(--th-text-secondary)" }}>
                  {formatMB(p.mem_peak_mb)}
                </td>
                <td className="py-2 text-right" style={{ color: "var(--th-text-secondary)" }}>
                  {p.minutes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Caption>Hover a CPU or memory peak to see who was busy in that minute.</Caption>
    </MonitoringPanel>
  );
}

// ── Disk health ─────────────────────────────────────────────────────────────

function diskFacts(d: PhysicalDisk): string[] {
  const facts: string[] = [];
  if (d.temperature_c != null) facts.push(`${d.temperature_c} °C`);
  if (d.wear_pct != null) facts.push(`${d.wear_pct}% worn`);
  if (d.power_on_hours != null) {
    const years = d.power_on_hours / 8766;
    facts.push(years >= 1 ? `${years.toFixed(1)} years on` : `${Math.round(d.power_on_hours / 24)} days on`);
  }
  const errors = (d.read_errors ?? 0) + (d.write_errors ?? 0);
  if (d.read_errors != null || d.write_errors != null)
    facts.push(errors ? `${errors} uncorrected errors` : "no errors");
  return facts;
}

function DiskHealthRow({ disk }: { disk: PhysicalDisk }) {
  const state = disk.predict_failure ? "unhealthy" : (disk.health ?? "unknown");
  const kind = [
    disk.media && disk.media !== "Unspecified" ? disk.media : null,
    disk.bus,
    disk.size_gb
      ? `${disk.size_gb >= 1000 ? `${(disk.size_gb / 1024).toFixed(1)} TB` : `${Math.round(disk.size_gb)} GB`}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = diskFacts(disk);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5" data-testid="disk-health-row">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }} title={disk.name}>
          {disk.name}
        </p>
        <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {[kind, ...facts].filter(Boolean).join(" · ") || "No reliability counters"}
        </p>
        {disk.problem && (
          <p className="mt-0.5 text-[12px] font-medium" style={{ color: HEALTH_TONE[state] ?? HEALTH_TONE.warning }}>
            {disk.problem}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {disk.temperature_c != null && disk.temperature_c >= 55 && (
          <Thermometer className="h-3.5 w-3.5" style={{ color: "var(--th-status-warning)" }} aria-label="Running hot" />
        )}
        <Chip tone={HEALTH_TONE[state] ?? HEALTH_TONE.unknown}>
          {disk.predict_failure ? "Failing" : (HEALTH_LABEL[state] ?? state)}
        </Chip>
      </div>
    </li>
  );
}

const NEEDS_AGENT = "Agent 2.1.33 reads disk health, pending restarts and critical events every hour.";

export function DiskHealthPanel({ health }: { health: DeviceHealth | null | undefined }) {
  const disks = health?.disks ?? [];
  const problems = disks.filter((d) => d.problem).length;
  return (
    <MonitoringPanel
      title="Disk health"
      icon={Disc3}
      label="Physical disk health"
      aside={
        health
          ? problems
            ? `${problems} need${problems === 1 ? "s" : ""} attention`
            : `SMART · read ${timeAgo(health.collected_at ?? "")}`
          : undefined
      }
    >
      {!health ? (
        <Muted>{NEEDS_AGENT} No report from this device yet.</Muted>
      ) : disks.length === 0 ? (
        <Muted>Windows reported no physical disks (a virtual machine or a RAID controller can hide them).</Muted>
      ) : (
        <ul className="-my-2.5 divide-y divide-[color:var(--th-border-drawer-section)]">
          {disks.map((d, i) => (
            <DiskHealthRow key={`${d.name}-${i}`} disk={d} />
          ))}
        </ul>
      )}
    </MonitoringPanel>
  );
}

// ── System health: pending restart and critical events ──────────────────────

const EVENT_TONE: Record<string, string> = {
  critical: "var(--th-status-critical)",
  error: "var(--th-status-warning)",
  warning: "var(--th-status-info)",
};
const CATEGORY_LABEL: Record<string, string> = {
  crash: "Crash",
  hardware: "Hardware",
  disk: "Disk",
  service: "Service",
};

function EventRow({ event }: { event: HealthEvent }) {
  const tone = EVENT_TONE[event.level] ?? EVENT_TONE.error;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5" data-testid="health-event">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
          <i className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: tone }} aria-hidden="true" />
          <span className="truncate">{event.title}</span>
        </p>
        <p
          className="truncate pl-4 text-[12px]"
          style={{ color: "var(--th-text-muted)" }}
          title={event.message ?? undefined}
        >
          {CATEGORY_LABEL[event.category] ?? event.category} · {event.source} {event.event_id}
          {event.message ? ` · ${event.message}` : ""}
        </p>
      </div>
      <span className="pt-0.5 text-right text-[12px] tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
        {formatLocalDateTime(event.at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
      </span>
    </li>
  );
}

export function SystemHealthPanel({ health }: { health: DeviceHealth | null | undefined }) {
  const events = health?.events ?? [];
  const alerting = events.filter((e) => e.category !== "service");
  const since = health?.reboot_pending_since;
  const days = since ? Math.floor((Date.now() - parseUTC(since).getTime()) / 86_400_000) : 0;
  return (
    <MonitoringPanel
      title="System health"
      icon={HeartPulse}
      aside={health ? `${alerting.length} critical event${alerting.length === 1 ? "" : "s"} · 7 days` : undefined}
    >
      {!health ? (
        <Muted>{NEEDS_AGENT} No report from this device yet.</Muted>
      ) : (
        <>
          <div
            className="th-drawer-tile flex items-center justify-between gap-3"
            data-testid="reboot-pending"
            data-pending={health.reboot_pending ? "true" : "false"}
          >
            <span className="flex min-w-0 items-center gap-2">
              <RotateCw
                className="h-4 w-4 flex-none"
                style={{ color: health.reboot_pending ? "var(--th-status-warning)" : "var(--th-text-faint)" }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                  {health.reboot_pending ? "Restart pending" : "No restart pending"}
                </span>
                {health.reboot_pending && (
                  <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                    {health.reboot_reasons.join(", ") || "Windows"}
                    {since && ` · since ${formatLocalDateTime(since, { day: "numeric", month: "short" })}`}
                  </span>
                )}
              </span>
            </span>
            {health.reboot_pending && since && (
              <Chip tone={days > 7 ? "var(--th-status-warning)" : "var(--th-status-info)"}>
                {days < 1 ? "today" : `${days} day${days === 1 ? "" : "s"}`}
              </Chip>
            )}
          </div>
          {events.length === 0 ? (
            <p className="mt-3 flex items-center gap-2 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              <AlertOctagon className="h-4 w-4" style={{ color: "var(--th-status-online)" }} aria-hidden="true" />
              No crash, blue screen, hardware or disk error in the last 7 days.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-[color:var(--th-border-drawer-section)]">
              {events.slice(0, 12).map((e) => (
                <EventRow key={`${e.source}-${e.event_id}-${e.at}`} event={e} />
              ))}
            </ul>
          )}
          {events.length > 12 && <Caption>Showing the 12 most recent of {events.length}.</Caption>}
        </>
      )}
    </MonitoringPanel>
  );
}
