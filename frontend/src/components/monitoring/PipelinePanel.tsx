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

/** A tier's share of the stored total, "42%" ("<1%" for a sliver, "—" when unknown). */
export function tierShare(bytes: number | null, total: number): string {
  if (bytes == null || !total) return "—";
  const pct = (bytes / total) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Storage tiers in one calm hue, finest data strongest: sequential, not an alarm. */
const TIER_TONES = [
  "var(--th-status-info)",
  "color-mix(in srgb, var(--th-status-info) 66%, var(--th-bg-card))",
  "color-mix(in srgb, var(--th-status-info) 40%, var(--th-bg-card))",
];
const tierTone = (index: number) => TIER_TONES[Math.min(index, TIER_TONES.length - 1)];

/** One line of a panel; both panels share it so their rows line up side by side. */
function Row({
  label,
  value,
  hint,
  lead,
  sub,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  lead?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <li className="th-mon-row">
      <span className="flex min-w-0 items-center gap-2.5">
        {lead}
        <span className="min-w-0">
          <span className="block truncate text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
            {label}
          </span>
          {hint && (
            <span className="block truncate text-[11px]" style={{ color: "var(--th-text-faint)" }}>
              {hint}
            </span>
          )}
        </span>
      </span>
      <span className="flex-none text-right">
        <span className="block text-[13px] font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>
          {value}
        </span>
        {sub && (
          <span className="block text-[11px] tabular-nums" style={{ color: "var(--th-text-faint)" }}>
            {sub}
          </span>
        )}
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
              <span className="th-mon-pill" style={tone(status.tone)}>
                <i />
                {status.label}
              </span>
            )
          }
        />
        <div className="th-onb-body !gap-3 flex-1">
          {error && !health && (
            <div className="th-onb-note" style={tone("var(--th-status-critical)")} role="alert">
              <Info className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          {!health && !error && <Skeleton rows={6} />}
          {health && (
            <ul className="th-mon-rows">
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
          tone="var(--th-status-info)"
          title="Storage"
          subtitle={health ? (anySize ? `${formatBytes(totalBytes)} in total` : "Size not reported") : "Loading…"}
        />
        <div className="th-onb-body !gap-3 flex-1">
          {!health && <Skeleton rows={4} />}
          {health && (
            <>
              <ul className="th-mon-rows">
                {health.storage.map((tier, index) => (
                  <Row
                    key={tier.name}
                    lead={<span className="th-mon-swatch" style={{ background: tierTone(index) }} aria-hidden />}
                    label={tier.name}
                    hint={`Kept ${tier.keep}`}
                    value={formatBytes(tier.bytes)}
                    sub={`${tierShare(tier.bytes, totalBytes)} of total`}
                  />
                ))}
                <Row label="Total" value={anySize ? formatBytes(totalBytes) : "—"} hint="Across all tiers" />
              </ul>
              <div className="th-mon-stack" role="img" aria-label="Share of storage by tier">
                {anySize ? (
                  health.storage.map((tier, index) =>
                    tier.bytes ? (
                      <i
                        key={tier.name}
                        title={`${tier.name}: ${formatBytes(tier.bytes)} (${tierShare(tier.bytes, totalBytes)})`}
                        style={{ flex: `${tier.bytes / totalBytes} 1 0`, background: tierTone(index) }}
                      />
                    ) : null,
                  )
                ) : (
                  <i style={{ flex: "1 1 0", background: "var(--th-ring-track)" }} />
                )}
              </div>
            </>
          )}
          <p className="th-onb-hint mt-auto">
            Raw samples, then 5-minute and hourly points with minimum, average and maximum. An expired day is dropped
            whole.
          </p>
        </div>
      </section>
    </>
  );
}
