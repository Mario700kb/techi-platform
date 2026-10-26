import React, { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  RotateCcw,
  Send,
  Waypoints,
} from "lucide-react";
import {
  formatBits,
  formatBytesRate,
  formatDuration,
  formatMs,
  getDeviceMetrics,
  getDeviceMonitoring,
  METRIC_LABEL,
  type DeliveryState,
  type DeviceMetrics,
  type DeviceMonitoring,
  type DiskTrend,
  type MetricPoint,
  type MetricsRange,
  type MonitorMetric,
  type MonitorStatus,
} from "../api/monitoring";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { metricTone } from "../utils/deviceStatus";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import {
  type ChartBand,
  COVERAGE_KINDS,
  CoverageBar,
  pct,
  RANGE_LABEL,
  RESOLUTION_WORD,
  Skeleton,
  Sparkline,
  StateChip,
  TimeChart,
} from "./MetricCharts";
import { Button } from "./ui";
import {
  AvailabilityPanel,
  Caption,
  DiskHealthPanel,
  MonitoringPanel as Panel,
  SystemHealthPanel,
  TopProcessesPanel,
} from "./monitoring/DeviceHealthPanels";

const RANGES: MetricsRange[] = ["1h", "24h", "7d", "30d", "13mo"];
const REFRESH_MS = 60_000;

// One cache per device and range, shared with the Overview card, so switching
// between the two shows the last answer at once.
export function useDeviceMetrics(deviceId: number, range: MetricsRange, enabled: boolean, coarse = false) {
  return useCachedQuery<DeviceMetrics>(
    enabled ? `mem.device.${deviceId}.metrics.${range}${coarse ? ".5m" : ""}` : null,
    () => (coarse ? getDeviceMetrics(deviceId, range, true) : getDeviceMetrics(deviceId, range)),
  );
}

export function useDeviceMonitors(deviceId: number, enabled: boolean) {
  return useCachedQuery<DeviceMonitoring>(enabled ? `mem.device.${deviceId}.monitoring` : null, () =>
    getDeviceMonitoring(deviceId),
  );
}

/** Reload every minute while shown and the browser tab is visible. */
export function useAutoRefresh(enabled: boolean, reloads: Array<() => Promise<void>>) {
  const [first, second] = reloads;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void first?.();
      void second?.();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, first, second]);
}

export function monitorName(m: Pick<MonitorStatus, "metric" | "key">): string {
  return METRIC_LABEL[m.metric as MonitorMetric] ?? m.key.replace(/_/g, " ");
}

/** "1-minute data from the agent · nothing lost" or the heartbeat fallback. */
export function sourceLine(metrics: Pick<DeviceMetrics, "source">): { text: string; tone: string } {
  if (metrics.source === "agent")
    return { text: "1-minute data from the agent · nothing lost", tone: "var(--th-status-online)" };
  if (metrics.source === "heartbeat")
    return {
      text: "5-minute heartbeat data — update the agent to 2.1.29 for 1-minute data",
      tone: "var(--th-status-warning)",
    };
  return { text: "No data from this device in this range", tone: "var(--th-text-faint)" };
}

function clockText(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  const sign = s > 0 ? "+" : s < 0 ? "−" : "±";
  return `${sign}${Math.abs(s) < 10 ? Math.abs(s).toFixed(1) : Math.round(Math.abs(s))} s`;
}

// Alert kinds drawn over each chart (backend AlertKind values).
const CHART_ALERTS = {
  cpu: ["high_cpu"],
  mem: ["high_ram"],
  diskIO: ["disk_busy"],
  net: ["high_network"],
  quality: ["network_latency", "packet_loss"],
} as const;

const SEVERITY_TONE: Record<string, string> = {
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
};

function bandsFor(metrics: DeviceMetrics, kinds: readonly string[]): ChartBand[] {
  return (metrics.alerts ?? [])
    .filter((a) => kinds.includes(a.kind))
    .map((a) => ({
      start: a.start,
      end: a.end,
      label: `Alert #${a.id}: ${a.message}`,
      tone: SEVERITY_TONE[a.severity] ?? SEVERITY_TONE.warning,
    }));
}

/** Coloured keys for a chart with more than one line. */
function Legend({ items }: { items: Array<{ label: string; tone: string }> }) {
  return (
    <span className="inline-flex items-center gap-3">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: item.tone }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </span>
  );
}

function SubChart({ title, legend, children }: { title: string; legend?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div
        className="mb-1 flex items-center justify-between gap-3 text-[12px]"
        style={{ color: "var(--th-text-muted)" }}
      >
        <span>{title}</span>
        {legend}
      </div>
      {children}
    </div>
  );
}

/** The busiest processes of the hovered minute, for the CPU and memory tooltips. */
function topTip(p: MetricPoint) {
  if (!p.top?.length) return null;
  return (
    <span className="mt-0.5 flex flex-col gap-0.5" data-testid="tip-top">
      {p.top.slice(0, 3).map((proc) => (
        <span key={proc.n} className="flex items-center justify-between gap-3">
          <span className="truncate">{proc.n}</span>
          <span className="tabular-nums" style={{ color: "var(--th-text-muted)" }}>
            {proc.c != null ? `${Math.round(proc.c)}%` : ""}
            {proc.m != null
              ? ` · ${proc.m >= 1024 ? `${(proc.m / 1024).toFixed(1)} GB` : `${Math.round(proc.m)} MB`}`
              : ""}
          </span>
        </span>
      ))}
    </span>
  );
}

function DiskRow({ disk }: { disk: DiskTrend }) {
  const tone = disk.monitored === false ? "var(--th-text-faint)" : metricTone("disk", disk.used_pct);
  const growth = disk.growth_gb_per_day;
  const forecast: string[] = [];
  if (disk.days_to_90 != null && disk.used_pct < 90) forecast.push(`90% in ${Math.round(disk.days_to_90)} days`);
  if (disk.days_to_full != null) forecast.push(`full in ${Math.round(disk.days_to_full)} days`);
  const growthText =
    growth == null
      ? null
      : Math.abs(growth) < 0.05
        ? "stable"
        : growth > 0
          ? `grows ${growth.toFixed(1)} GB/day`
          : `shrinks ${Math.abs(growth).toFixed(1)} GB/day`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-4 py-2.5" data-testid="disk-row">
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px] tabular-nums">
          <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {disk.mount}
          </span>
          <span style={{ color: "var(--th-text-muted)" }}>
            {Math.round(disk.used_pct)}%{disk.free_gb != null && ` · ${disk.free_gb.toFixed(1)} GB free`}
            {disk.total_gb != null && ` of ${Math.round(disk.total_gb)} GB`}
          </span>
        </div>
        <div
          className="th-onb-meter !h-1.5 !w-full"
          role="progressbar"
          aria-label={`${disk.mount} used`}
          aria-valuenow={Math.round(disk.used_pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <i style={{ width: `${Math.min(100, disk.used_pct)}%`, "--meter-tone": tone } as React.CSSProperties} />
        </div>
        <p className="mt-1 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {disk.monitored === false
            ? "Small volume (under 5 GB) · shown, not alerted on"
            : [growthText, ...forecast].filter(Boolean).join(" · ") || "Not enough history for a forecast yet"}
        </p>
      </div>
      <div title="Used % per day, last days">
        <Sparkline
          values={disk.history}
          tone={forecast.length ? "var(--th-status-warning)" : "var(--th-series-2)"}
          label={`${disk.mount} used per day`}
          min={0}
          max={100}
        />
      </div>
    </li>
  );
}

function MonitorRow({ m, onShowAlerts }: { m: MonitorStatus; onShowAlerts?: () => void }) {
  return (
    <li className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-3 py-2.5" data-state={m.state}>
      <StateChip state={m.state} />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
          {monitorName(m)}
        </p>
        <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {m.rule}
          {m.severity ? ` · ${m.severity}` : ""}
        </p>
      </div>
      <div className="text-right text-[12px] tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
        {m.now ?? "—"}
        {m.state === "firing" && m.alert_id != null && onShowAlerts && (
          <button
            type="button"
            onClick={onShowAlerts}
            className="block w-full text-right text-[12px] font-medium"
            style={{ color: "var(--th-accent)" }}
          >
            Alert #{m.alert_id}
          </button>
        )}
      </div>
    </li>
  );
}

function DeliveryTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="th-drawer-tile flex h-full flex-col">
      <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </span>
      <span className="mt-1 text-[14px] font-semibold tabular-nums" style={{ color: tone ?? "var(--th-text-primary)" }}>
        {value}
      </span>
      <span className="mt-0.5 min-h-[16px] truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
        {sub ?? ""}
      </span>
    </div>
  );
}

function Delivery({ delivery, policyNames }: { delivery: DeliveryState | null; policyNames: string[] }) {
  if (!delivery) {
    return (
      <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
        No uploads from this device yet. Agents from 2.1.29 send their 1-minute samples every 15 minutes.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="delivery">
      <DeliveryTile
        label="Last upload"
        value={delivery.last_upload_at ? timeAgo(delivery.last_upload_at) : "Never"}
        sub={delivery.last_sample_at ? `newest sample ${timeAgo(delivery.last_sample_at)}` : undefined}
      />
      <DeliveryTile
        label="Waiting on device"
        value={delivery.pending ? `${delivery.pending} samples` : "Nothing waiting"}
        sub={delivery.oldest_pending_at ? `oldest ${timeAgo(delivery.oldest_pending_at)}` : "backlog empty"}
        tone={delivery.pending > 60 ? "var(--th-status-warning)" : undefined}
      />
      <DeliveryTile
        label="Lost samples"
        value={String(delivery.dropped_total)}
        sub={delivery.dropped_total ? "buffer was full" : "none dropped"}
        tone={delivery.dropped_total ? "var(--th-status-critical)" : undefined}
      />
      <DeliveryTile
        label="Clock offset"
        value={clockText(delivery.clock_offset_ms)}
        sub={delivery.clock_offset_ms != null ? "corrected on arrival" : undefined}
      />
      <DeliveryTile
        label="Sampling"
        value={delivery.sample_seconds ? `every ${delivery.sample_seconds} s` : "—"}
        sub={policyNames.length ? policyNames.join(" + ") : undefined}
      />
      <DeliveryTile
        label="Policy"
        value={delivery.policy_version ? `v${delivery.policy_version}` : "—"}
        sub={delivery.policy_current ? "current" : "behind · applies at next upload"}
        tone={delivery.policy_current ? undefined : "var(--th-status-warning)"}
      />
    </div>
  );
}

/**
 * Monitoring tab: what the device's agent measured over a chosen range (CPU,
 * memory, network, disks with a forecast), how much of that range the
 * platform actually holds, the monitors that watch it and how its samples
 * are getting here.
 */
export default function DeviceMonitoringPanel({
  deviceId,
  active,
  onShowAlerts,
}: {
  deviceId: number;
  active: boolean;
  /** Firing monitors link to the device's alerts. */
  onShowAlerts?: () => void;
}) {
  const [range, setRange] = useState<MetricsRange>("24h");
  const metricsQuery = useDeviceMetrics(deviceId, range, active);
  const monitorsQuery = useDeviceMonitors(deviceId, active);
  useAutoRefresh(active && (range === "1h" || range === "24h"), [metricsQuery.reload, monitorsQuery.reload]);

  const metrics = metricsQuery.data;
  const monitoring = monitorsQuery.data;
  const source = metrics ? sourceLine(metrics) : null;
  const s = metrics?.summary;
  const off = metrics?.coverage.segments.filter((seg) => seg.kind === "off") ?? [];
  const thresholdFor = (metric: "cpu" | "mem") => {
    const m = metrics?.policy.monitors.find((x) => x.metric === metric && x.enabled && x.op === ">");
    return m ? { value: m.threshold, label: `alert ${m.threshold}% · ${formatDuration(m.duration_s)}` } : null;
  };
  const thresholdOf = (metric: string, unit: string) => {
    const m = metrics?.policy.monitors.find((x) => x.metric === metric && x.enabled && x.op === ">");
    return m ? { value: m.threshold, label: `alert ${m.threshold}${unit} · ${formatDuration(m.duration_s)}` } : null;
  };
  const restarts = (metrics?.restarts ?? []).map((t) => ({
    t,
    label: `Restarted ${formatLocalDateTime(t, { hour: "2-digit", minute: "2-digit" })}`,
  }));
  const hasDiskIO = metrics?.points.some((p) => p.disk_busy_avg != null) ?? false;
  const hasQuality = metrics?.points.some((p) => p.gw_ms_avg != null || p.wan_ms_avg != null) ?? false;
  const hasLoss = metrics?.points.some((p) => (p.gw_loss_max ?? 0) > 0) ?? false;
  const resWord = metrics ? (RESOLUTION_WORD[metrics.resolution] ?? metrics.resolution) : "";
  const hasPoints = (metrics?.points.length ?? 0) > 0;
  const policyNames = monitoring?.policy.policies ?? metrics?.policy.policies ?? [];
  const delivery = monitoring?.delivery ?? metrics?.delivery ?? null;
  const cov = metrics?.coverage;

  return (
    <div data-testid="device-monitoring">
      <div className="mb-3">
        <div
          className="th-segmented w-full"
          role="radiogroup"
          aria-label="Time range"
          data-thumb
          style={{ "--seg-n": RANGES.length, "--seg-i": RANGES.indexOf(range) } as React.CSSProperties}
        >
          {RANGES.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} onClick={() => setRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="mt-2 flex min-h-[18px] items-center justify-between gap-3 text-[12px]">
          {source ? (
            <span className="flex min-w-0 items-center gap-2" style={{ color: "var(--th-text-secondary)" }}>
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: source.tone }} aria-hidden="true" />
              <span className="truncate" data-testid="metrics-source">
                {source.text}
              </span>
            </span>
          ) : (
            <span />
          )}
          {metrics && hasPoints && (
            <span className="flex-none" style={{ color: "var(--th-text-faint)" }}>
              {resWord} points
            </span>
          )}
        </div>
      </div>

      {metricsQuery.error && !metrics ? (
        <div className="th-drawer-card mb-3 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px]" style={{ color: "var(--th-status-critical)" }}>
            <AlertTriangle className="h-4 w-4" />
            Couldn't load metrics.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void metricsQuery.reload()}>
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      ) : !metrics ? (
        <div aria-busy="true" aria-label="Loading metrics">
          {[128, 104, 104].map((h, i) => (
            <div key={i} className="th-drawer-card mb-3">
              <Skeleton height={14} className="mb-3 w-1/3" />
              <Skeleton height={h} />
            </div>
          ))}
        </div>
      ) : !hasPoints ? (
        <div className="th-drawer-card mb-3 py-8 text-center">
          <Activity className="mx-auto mb-2 h-5 w-5" style={{ color: "var(--th-text-faint)" }} />
          <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            No metrics in the last {RANGE_LABEL[range]}
          </p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            The charts fill in as the device reports.
          </p>
        </div>
      ) : (
        <>
          {cov && cov.segments.length > 0 && (
            <AvailabilityPanel
              segments={cov.segments}
              restarts={metrics.restarts ?? []}
              start={metrics.start}
              end={metrics.end}
            />
          )}
          <Panel
            title="CPU"
            icon={Cpu}
            aside={
              s && (
                <>
                  avg {pct(s.cpu_avg)} · p95 {pct(s.cpu_p95)} · peak {pct(s.cpu_peak)}
                  {s.cpu_peak_at &&
                    ` at ${formatLocalDateTime(s.cpu_peak_at, range === "1h" || range === "24h" ? { hour: "2-digit", minute: "2-digit" } : undefined)}`}
                </>
              )
            }
          >
            <TimeChart
              label="CPU usage over time"
              points={metrics.points}
              start={metrics.start}
              end={metrics.end}
              range={range}
              resolution={metrics.resolution}
              domainMax={100}
              format={(v) => `${Math.round(v)}%`}
              threshold={thresholdFor("cpu")}
              off={off}
              markers={restarts}
              bands={bandsFor(metrics, CHART_ALERTS.cpu)}
              tipExtra={topTip}
              height={132}
              series={[
                { key: "cpu", label: "CPU", tone: "var(--th-series-2)", avg: (p) => p.cpu_avg, max: (p) => p.cpu_max },
              ]}
            />
            <Caption>
              Line: {resWord} average · shaded: highest {metrics.source === "agent" ? "minute" : "sample"} in each step,
              so short spikes stay visible.
            </Caption>
          </Panel>

          <Panel title="Memory" icon={MemoryStick} aside={s && `avg ${pct(s.mem_avg)} · peak ${pct(s.mem_peak)}`}>
            <TimeChart
              label="Memory used over time"
              points={metrics.points}
              start={metrics.start}
              end={metrics.end}
              range={range}
              resolution={metrics.resolution}
              domainMax={100}
              format={(v) => `${Math.round(v)}%`}
              threshold={thresholdFor("mem")}
              off={off}
              markers={restarts}
              bands={bandsFor(metrics, CHART_ALERTS.mem)}
              tipExtra={topTip}
              height={108}
              series={[
                {
                  key: "mem",
                  label: "Memory",
                  tone: "var(--th-series-2)",
                  avg: (p) => p.mem_avg,
                  max: (p) => p.mem_max,
                },
              ]}
            />
          </Panel>

          {hasDiskIO && (
            <Panel
              title="Disk activity"
              icon={Gauge}
              aside={
                s && (
                  <>
                    busy avg {pct(s.disk_busy_avg)} · peak {pct(s.disk_busy_peak)} · read peak{" "}
                    {formatBytesRate(s.disk_read_peak)}
                  </>
                )
              }
            >
              <TimeChart
                label="Disk busy time over time"
                points={metrics.points}
                start={metrics.start}
                end={metrics.end}
                range={range}
                resolution={metrics.resolution}
                domainMax={100}
                format={(v) => `${Math.round(v)}%`}
                threshold={thresholdOf("disk_busy", "%")}
                off={off}
                markers={restarts}
                bands={bandsFor(metrics, CHART_ALERTS.diskIO)}
                height={108}
                series={[
                  {
                    key: "busy",
                    label: "Busy",
                    tone: "var(--th-series-2)",
                    avg: (p) => p.disk_busy_avg ?? null,
                    max: (p) => p.disk_busy_max ?? null,
                  },
                ]}
              />
              <SubChart
                title="Read and write"
                legend={
                  <Legend
                    items={[
                      { label: "Read", tone: "var(--th-series-2)" },
                      { label: "Write", tone: "var(--th-series-1)" },
                    ]}
                  />
                }
              >
                <TimeChart
                  label="Disk read and write over time"
                  points={metrics.points}
                  start={metrics.start}
                  end={metrics.end}
                  range={range}
                  resolution={metrics.resolution}
                  format={formatBytesRate}
                  axisFormat={(v) => (v === 0 ? "0" : formatBytesRate(v))}
                  off={off}
                  height={92}
                  series={[
                    { key: "read", label: "Read", tone: "var(--th-series-2)", avg: (p) => p.disk_read_avg ?? null },
                    { key: "write", label: "Write", tone: "var(--th-series-1)", avg: (p) => p.disk_write_avg ?? null },
                  ]}
                />
              </SubChart>
              <Caption>
                Busy: share of each minute the busiest volume had requests waiting — near 100% for long means the disk
                is what makes the machine slow.
              </Caption>
            </Panel>
          )}

          <Panel
            title="Network"
            icon={Network}
            aside={
              s && (
                <span className="inline-flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5">
                    <i className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--th-series-2)" }} />↓ peak{" "}
                    {formatBits(s.rx_peak)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <i className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--th-series-1)" }} />↑ peak{" "}
                    {formatBits(s.tx_peak)}
                  </span>
                </span>
              )
            }
          >
            {metrics.points.some((p) => p.rx_avg != null || p.tx_avg != null) ? (
              <TimeChart
                label="Network receive and send over time"
                points={metrics.points}
                start={metrics.start}
                end={metrics.end}
                range={range}
                resolution={metrics.resolution}
                format={formatBits}
                axisFormat={(v) => (v === 0 ? "0" : formatBits(v))}
                off={off}
                markers={restarts}
                bands={bandsFor(metrics, CHART_ALERTS.net)}
                height={108}
                series={[
                  { key: "rx", label: "↓ Receive", tone: "var(--th-series-2)", avg: (p) => p.rx_avg },
                  { key: "tx", label: "↑ Send", tone: "var(--th-series-1)", avg: (p) => p.tx_avg },
                ]}
              />
            ) : (
              <p className="py-4 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                {metrics.source === "heartbeat"
                  ? "Heartbeats carry no network data. Agent 2.1.29 adds it."
                  : "No network data in this range."}
              </p>
            )}
          </Panel>

          {hasQuality && (
            <Panel
              title="Network quality"
              icon={Waypoints}
              aside={
                s && (
                  <span className="inline-flex items-center gap-3">
                    <Legend
                      items={[
                        { label: `Gateway ${formatMs(s.gw_ms_avg)}`, tone: "var(--th-series-2)" },
                        { label: `Platform ${formatMs(s.wan_ms_avg)}`, tone: "var(--th-series-1)" },
                      ]}
                    />
                    <span>loss {s.gw_loss_avg != null ? `${+s.gw_loss_avg.toFixed(1)}%` : "—"}</span>
                  </span>
                )
              }
            >
              <TimeChart
                label="Latency to the gateway and the platform over time"
                points={metrics.points}
                start={metrics.start}
                end={metrics.end}
                range={range}
                resolution={metrics.resolution}
                format={formatMs}
                axisFormat={(v) => (v === 0 ? "0" : formatMs(v))}
                threshold={thresholdOf("gw_ms", " ms")}
                off={off}
                markers={restarts}
                bands={bandsFor(metrics, CHART_ALERTS.quality)}
                height={108}
                series={[
                  {
                    key: "gw",
                    label: "Gateway",
                    tone: "var(--th-series-2)",
                    avg: (p) => p.gw_ms_avg ?? null,
                    max: (p) => p.gw_ms_max ?? null,
                  },
                  { key: "wan", label: "Platform", tone: "var(--th-series-1)", avg: (p) => p.wan_ms_avg ?? null },
                ]}
              />
              {hasLoss ? (
                <SubChart title="Packet loss to the gateway">
                  <TimeChart
                    label="Packet loss to the gateway over time"
                    points={metrics.points}
                    start={metrics.start}
                    end={metrics.end}
                    range={range}
                    resolution={metrics.resolution}
                    domainMax={100}
                    format={(v) => `${Math.round(v)}%`}
                    threshold={thresholdOf("gw_loss", "%")}
                    off={off}
                    height={80}
                    series={[
                      {
                        key: "loss",
                        label: "Loss",
                        tone: "var(--th-status-critical)",
                        avg: (p) => p.gw_loss_avg ?? null,
                        max: (p) => p.gw_loss_max ?? null,
                      },
                    ]}
                  />
                </SubChart>
              ) : (
                <Caption>No packet lost to the gateway in this range.</Caption>
              )}
            </Panel>
          )}

          {metrics.source === "agent" && (hasDiskIO || (metrics.processes?.length ?? 0) > 0) && (
            <TopProcessesPanel processes={metrics.processes ?? []} range={range} />
          )}
        </>
      )}

      {metrics && (
        <Panel
          title="Disks"
          icon={HardDrive}
          aside={metrics.disks.length ? "forecast from the last 14 days" : undefined}
        >
          {metrics.disks.length === 0 ? (
            <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              No disk history yet.
            </p>
          ) : (
            <ul className="-my-2.5 divide-y divide-[color:var(--th-border-drawer-section)]">
              {metrics.disks.map((d) => (
                <DiskRow key={d.mount} disk={d} />
              ))}
            </ul>
          )}
        </Panel>
      )}

      {(monitoring || metrics) && <DiskHealthPanel health={monitoring?.health} />}
      {(monitoring || metrics) && <SystemHealthPanel health={monitoring?.health} />}

      {metrics && cov && (
        <Panel
          title={`Data coverage · ${RANGE_LABEL[range]}`}
          label="Data coverage"
          aside={
            cov.pct != null ? (
              <span>
                <strong style={{ color: "var(--th-text-primary)" }}>{+cov.pct.toFixed(2)}%</strong> while on
              </span>
            ) : (
              "no data"
            )
          }
        >
          <CoverageBar segments={cov.segments} start={metrics.start} end={metrics.end} />
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] tabular-nums">
            {COVERAGE_KINDS.map((k) => {
              const value =
                k.kind === "received"
                  ? `${cov.received} samples`
                  : k.kind === "late"
                    ? `${cov.late} samples`
                    : k.kind === "missing"
                      ? cov.missing_minutes
                        ? formatDuration(cov.missing_minutes * 60)
                        : "none"
                      : cov.off_minutes
                        ? formatDuration(cov.off_minutes * 60)
                        : "none";
              return (
                <div key={k.kind} className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5" style={{ color: "var(--th-text-muted)" }}>
                    <i
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ background: k.tone, boxShadow: "inset 0 0 0 1px var(--th-border-subtle)" }}
                    />
                    {k.label}
                  </dt>
                  <dd style={{ color: "var(--th-text-primary)" }}>{value}</dd>
                </div>
              );
            })}
          </dl>
          <Caption>
            Late samples were held on the device while it was offline and sent later. Device off is not missing.
          </Caption>
        </Panel>
      )}

      <Panel
        title="Monitors"
        icon={Activity}
        aside={
          monitoring && policyNames.length ? `${policyNames.join(" + ")} · v${monitoring.policy.version}` : undefined
        }
      >
        {monitorsQuery.error && !monitoring ? (
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span style={{ color: "var(--th-status-critical)" }}>Couldn't load monitors.</span>
            <Button size="sm" variant="secondary" onClick={() => void monitorsQuery.reload()}>
              Retry
            </Button>
          </div>
        ) : !monitoring ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : monitoring.monitors.length === 0 ? (
          <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            No monitors apply to this device.
          </p>
        ) : (
          <ul className="-my-2.5 divide-y divide-[color:var(--th-border-drawer-section)]">
            {monitoring.monitors.map((m) => (
              <MonitorRow key={m.key} m={m} onShowAlerts={onShowAlerts} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Delivery" icon={Send}>
        {!monitoring && !metrics ? (
          <div className="grid grid-cols-2 gap-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={68} />
            ))}
          </div>
        ) : (
          <Delivery delivery={delivery} policyNames={policyNames} />
        )}
      </Panel>
    </div>
  );
}
