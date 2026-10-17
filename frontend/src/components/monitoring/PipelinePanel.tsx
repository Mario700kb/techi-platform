import type { CSSProperties, ReactNode } from "react";
import { Database, Info, Workflow } from "lucide-react";

import { formatDuration } from "../../api/monitoring";
import type { PipelineHealth } from "../../api/monitoring";
import { CardHead } from "../ui/PanelCard";
import { formatCount } from "../../utils/number";
import { parseUTC } from "../../utils/time";
import { devicesWord, formatBytes } from "./policyForm";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;

/** Share of samples lost in 30 days, in plain words ("0%", "<0.01%", "0.25%"). */
export function lostShare(dropped: number, samples: number): string {
  const total = dropped + samples;
  if (!total || !dropped) return "0%";
  const pct = (dropped / total) * 100;
  if (pct < 0.01) return "<0.01%";
  return `${+pct.toFixed(pct < 1 ? 2 : 1)}%`;
}

/** Healthy unless data arrives late or gets lost: a median delay over 30 min or over 1% lost. */
export function pipelineStatus(health: PipelineHealth): { label: string; tone: string } {
  const total = health.dropped_30d + health.samples_30d;
  const lost = total ? health.dropped_30d / total : 0;
  if ((health.median_delay_seconds ?? 0) > 1800 || lost > 0.01)
    return { label: "Check", tone: "var(--th-status-warning)" };
  return { label: "Healthy", tone: "var(--th-status-online)" };
}

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
          {label}
        </span>
        {hint && (
          <span className="block text-[11px]" style={{ color: "var(--th-text-faint)" }}>
            {hint}
          </span>
        )}
      </span>
      <span
        className="flex-none text-right text-[13px] font-semibold tabular-nums"
        style={{ color: "var(--th-text-primary)" }}
      >
        {value}
      </span>
    </li>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="py-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

export default function PipelinePanel({
  health,
  error,
  now = Date.now(),
}: {
  health: PipelineHealth | undefined;
  error: string | null;
  now?: number;
}) {
  const status = health ? pipelineStatus(health) : null;
  const oldest = health?.oldest_backlog_at
    ? formatDuration(Math.max(0, Math.round((now - parseUTC(health.oldest_backlog_at).getTime()) / 1000)))
    : null;
  const totalBytes = health?.storage.reduce((sum, t) => sum + (t.bytes ?? 0), 0) ?? 0;
  const anySize = health?.storage.some((t) => t.bytes != null) ?? false;

  return (
    <>
      <section className="th-onb-card" aria-label="Pipeline health">
        <CardHead
          icon={Workflow}
          tone="var(--th-status-info)"
          title="Pipeline health"
          subtitle="Refreshed every minute"
          aside={
            status && (
              <span className="th-team-state" style={tone(status.tone)}>
                <i />
                {status.label}
              </span>
            )
          }
        />
        <div className="th-onb-body !gap-3">
          {error && !health && (
            <div className="th-onb-note" style={tone("var(--th-status-critical)")} role="alert">
              <Info className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          {!health && !error && <Skeleton rows={6} />}
          {health && (
            <ul className="flex flex-col gap-3">
              <Row
                label="Sending 1-minute data"
                value={`${formatCount(health.devices_one_minute)} / ${formatCount(health.devices_online)}`}
                hint="Devices uploading, of those online"
              />
              <Row label="Uploaded in the last hour" value={devicesWord(health.uploads_last_hour)} />
              <Row
                label="Median delay"
                value={health.median_delay_seconds == null ? "—" : formatDuration(health.median_delay_seconds)}
                hint="From sample to platform"
              />
              <Row
                label="Devices with a backlog"
                value={`${formatCount(health.devices_with_backlog)}${oldest ? ` · oldest ${oldest}` : ""}`}
              />
              <Row label="Samples lost, 30 days" value={lostShare(health.dropped_30d, health.samples_30d)} />
              <Row
                label="Policy behind"
                value={devicesWord(health.policy_behind)}
                hint="Usually offline; they update on their next heartbeat"
              />
            </ul>
          )}
        </div>
      </section>

      <section className="th-onb-card" aria-label="Storage">
        <CardHead
          icon={Database}
          tone="var(--th-status-maint)"
          title="Storage"
          subtitle={health ? (anySize ? `${formatBytes(totalBytes)} in total` : "Size not reported") : "Loading…"}
        />
        <div className="th-onb-body !gap-4">
          {!health && <Skeleton rows={3} />}
          {health && (
            <ul className="flex flex-col gap-4">
              {health.storage.map((tier) => {
                const share = totalBytes && tier.bytes ? (tier.bytes / totalBytes) * 100 : 0;
                return (
                  <li key={tier.name}>
                    <div className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="font-medium" style={{ color: "var(--th-text-primary)" }}>
                        {tier.name}
                      </span>
                      <span className="tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                        {tier.keep} · {formatBytes(tier.bytes)}
                      </span>
                    </div>
                    <div
                      className="mt-1.5 h-1.5 overflow-hidden rounded-full"
                      style={{ background: "var(--th-ring-track)" }}
                      role="presentation"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(share, tier.bytes ? 2 : 0)}%`, background: "var(--th-accent)" }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="th-onb-hint">
            Raw samples, then 5-minute and hourly points with minimum, average and maximum. An expired day is dropped
            whole.
          </p>
        </div>
      </section>
    </>
  );
}
