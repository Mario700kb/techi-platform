import React from "react";
import { ChevronRight } from "lucide-react";
import type { DeviceMonitoring, MonitorStatus } from "../api/monitoring";
import { formatLocalDateTime } from "../utils/time";
import { CoverageBar, pct, Skeleton, StateChip, TimeChart } from "./MetricCharts";
import { monitorName, sourceLine, useDeviceMetrics, useDeviceMonitors } from "./DeviceMonitoringPanel";
import { Button, SectionHeader } from "./ui";

const SHORT: Record<string, string> = {
  cpu: "CPU",
  mem: "Memory",
  disk: "Disk",
  net_rx_mbps: "Receive",
  net_tx_mbps: "Send",
  disk_forecast_days: "Disk forecast",
  no_data: "Agent",
};

/** "All 4 monitors OK", "1 firing · CPU above 95% for 15 min", … */
export function monitorsSummary(monitoring: DeviceMonitoring | undefined): {
  state: MonitorStatus["state"];
  text: string;
} | null {
  if (!monitoring) return null;
  const on = monitoring.monitors.filter((m) => m.enabled);
  if (on.length === 0) return { state: "unknown", text: "No monitors apply" };
  const describe = (m: MonitorStatus) => `${SHORT[m.metric] ?? monitorName(m)} ${m.rule}`;
  const firing = on.filter((m) => m.state === "firing");
  if (firing.length) {
    const rest = firing.length > 1 ? ` (+${firing.length - 1} more)` : "";
    return { state: "firing", text: `${firing.length} firing · ${describe(firing[0])}${rest}` };
  }
  const watch = on.filter((m) => m.state === "watch");
  if (watch.length) return { state: "watch", text: `${watch.length} near the limit · ${describe(watch[0])}` };
  if (on.every((m) => m.state === "unknown")) return { state: "unknown", text: "Monitors are waiting for data" };
  return { state: "ok", text: on.length === 1 ? "The monitor is OK" : `All ${on.length} monitors OK` };
}

function Stat({
  label,
  tone,
  value,
  detail,
  children,
}: {
  label: string;
  tone?: string;
  value: string;
  detail: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="th-drawer-tile flex h-full min-w-0 flex-col !p-3">
      <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        {tone && <i className="inline-block h-2 w-2 flex-none rounded-sm" style={{ background: tone }} />}
        {label}
      </span>
      <span className="mt-1 text-lg font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>
        {value}
      </span>
      <span
        className="mt-0.5 min-h-[32px] text-[11px] leading-4 tabular-nums"
        style={{ color: "var(--th-text-muted)" }}
      >
        {detail}
      </span>
      {children}
    </div>
  );
}

/**
 * Overview: how the device did over the last day — averages, peaks, how
 * much of the day the platform holds and what the monitors say. History
 * only: current values live in the Live panel above.
 */
export default function DeviceLast24hCard({
  deviceId,
  active,
  onOpenMonitoring,
}: {
  deviceId: number;
  active: boolean;
  onOpenMonitoring?: () => void;
}) {
  const metricsQuery = useDeviceMetrics(deviceId, "24h", active);
  const monitorsQuery = useDeviceMonitors(deviceId, active);
  const metrics = metricsQuery.data;
  const s = metrics?.summary;
  const summary = monitorsSummary(monitorsQuery.data);
  const source = metrics ? sourceLine(metrics) : null;
  const hasPoints = (metrics?.points.length ?? 0) > 0;

  return (
    <section className="mb-3.5" aria-label="Last 24 hours">
      <SectionHeader
        title="Last 24 hours"
        meta={
          source && metrics?.source !== "none"
            ? metrics?.source === "agent"
              ? "1-minute data · nothing lost"
              : "5-minute heartbeat data"
            : undefined
        }
      />
      <div className="th-drawer-card">
        {metricsQuery.error && !metrics ? (
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span style={{ color: "var(--th-text-muted)" }}>Couldn't load the last 24 hours.</span>
            <Button size="sm" variant="secondary" onClick={() => void metricsQuery.reload()}>
              Retry
            </Button>
          </div>
        ) : !metrics ? (
          <div aria-busy="true" aria-label="Loading the last 24 hours">
            <Skeleton height={88} className="mb-3" />
            <div className="grid grid-cols-3 gap-2">
              <Skeleton height={72} />
              <Skeleton height={72} />
              <Skeleton height={72} />
            </div>
          </div>
        ) : !hasPoints ? (
          <p className="py-2 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            No data in the last 24 hours. It fills in as the device reports.
          </p>
        ) : (
          <>
            <TimeChart
              label="CPU and memory over the last 24 hours"
              points={metrics.points}
              start={metrics.start}
              end={metrics.end}
              range="24h"
              resolution={metrics.resolution}
              domainMax={100}
              format={(v) => `${Math.round(v)}%`}
              off={metrics.coverage.segments.filter((seg) => seg.kind === "off")}
              height={96}
              series={[
                { key: "cpu", label: "CPU", tone: "var(--th-series-2)", avg: (p) => p.cpu_avg },
                { key: "mem", label: "Memory", tone: "var(--th-series-1)", avg: (p) => p.mem_avg },
              ]}
            />
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Stat
                label="CPU avg"
                tone="var(--th-series-2)"
                value={pct(s?.cpu_avg)}
                detail={
                  <>
                    p95 {pct(s?.cpu_p95)}
                    <br />
                    peak {pct(s?.cpu_peak)}
                    {s?.cpu_peak_at &&
                      ` at ${formatLocalDateTime(s.cpu_peak_at, { hour: "2-digit", minute: "2-digit" })}`}
                  </>
                }
              />
              <Stat
                label="Memory avg"
                tone="var(--th-series-1)"
                value={pct(s?.mem_avg)}
                detail={
                  <>
                    peak {pct(s?.mem_peak)}
                    <br />
                    over the day
                  </>
                }
              />
              <Stat
                label="Coverage"
                value={metrics.coverage.pct != null ? `${+metrics.coverage.pct.toFixed(1)}%` : "—"}
                detail="of the time it was on"
              >
                <div className="-mt-3">
                  <CoverageBar
                    segments={metrics.coverage.segments}
                    start={metrics.start}
                    end={metrics.end}
                    height={4}
                  />
                </div>
              </Stat>
            </div>
          </>
        )}

        <div
          className="mt-3 flex items-center gap-3 border-t pt-3"
          style={{ borderColor: "var(--th-border-drawer-section)" }}
        >
          {summary ? (
            <>
              <StateChip state={summary.state} />
              <span
                className="min-w-0 flex-1 truncate text-[13px]"
                style={{ color: "var(--th-text-secondary)" }}
                data-testid="monitors-summary"
              >
                {summary.text}
              </span>
            </>
          ) : monitorsQuery.error ? (
            <span className="min-w-0 flex-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              Monitors unavailable
            </span>
          ) : (
            <Skeleton height={20} className="flex-1" />
          )}
          {onOpenMonitoring && (
            <Button size="sm" variant="secondary" className="flex-none" onClick={onOpenMonitoring}>
              Open Monitoring
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
