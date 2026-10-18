// The monitoring policy editor's form: the policy as editable strings, the
// limits the backend enforces (app/schemas/telemetry_pipeline.py and
// services/monitoring_policy_service.py), and plain words for a policy's scope.
import type { Client, DeviceGroup } from "../../api/clients";
import { formatCount } from "../../utils/number";
import type {
  Monitor,
  MonitoringPolicy,
  MonitorMetric,
  MonitorSeverity,
  PolicyBody,
  PolicyScope,
} from "../../api/monitoring";

export const LIMITS = {
  sample: { min: 30, max: 900 },
  uploadMin: { min: 1, max: 60 },
  buffer: { min: 5, max: 500 },
  keepDays: { min: 1, max: 30 },
  durationMin: { min: 0, max: 1440 },
  monitors: 40,
} as const;

export const METRICS: MonitorMetric[] = [
  "cpu",
  "mem",
  "disk",
  "disk_busy",
  "net_rx_mbps",
  "net_tx_mbps",
  "gw_ms",
  "gw_loss",
  "service",
  "disk_forecast_days",
  "disk_health",
  "critical_events",
  "reboot_pending_days",
  "security_score",
  "no_data",
];

/** Monitors the platform evaluates itself; the rest run on the device every sample. */
export const SERVER_METRICS = new Set<MonitorMetric>([
  "disk_forecast_days",
  "no_data",
  "disk_health",
  "critical_events",
  "reboot_pending_days",
  "security_score",
]);

/** Monitors that need agent 2.1.33 on the device (the rest work from 2.1.29, security from 2.1.31). */
export const NEEDS_AGENT: Partial<Record<MonitorMetric, string>> = {
  disk_busy: "2.1.33",
  gw_ms: "2.1.33",
  gw_loss: "2.1.33",
  service: "2.1.33",
  disk_health: "2.1.33",
  critical_events: "2.1.33",
  reboot_pending_days: "2.1.33",
  security_score: "2.1.31",
};

/**
 * How a metric's condition is written: "op" (choose > or <, a value), "below"
 * (always <), "above" (always >), "none" (no value: any problem / no data),
 * "service" (the services to watch). `duration`: whether it must hold a while.
 */
export const METRIC_SHAPE: Record<
  MonitorMetric,
  { condition: "op" | "below" | "above" | "none" | "service"; duration: boolean; words?: string }
> = {
  cpu: { condition: "op", duration: true },
  mem: { condition: "op", duration: true },
  disk: { condition: "op", duration: true },
  disk_busy: { condition: "op", duration: true },
  net_rx_mbps: { condition: "op", duration: true },
  net_tx_mbps: { condition: "op", duration: true },
  gw_ms: { condition: "op", duration: true },
  gw_loss: { condition: "op", duration: true },
  service: { condition: "service", duration: true },
  disk_forecast_days: { condition: "below", duration: false, words: "Full within" },
  disk_health: { condition: "none", duration: false, words: "Any disk problem" },
  critical_events: { condition: "above", duration: false, words: "More than, in 24 h" },
  reboot_pending_days: { condition: "above", duration: false, words: "Pending longer than" },
  security_score: { condition: "below", duration: false, words: "Score below" },
  no_data: { condition: "none", duration: true, words: "No uploads" },
};

/** Service names as the backend accepts them; a trailing * matches a prefix. */
export const SERVICE_NAME = /^[A-Za-z0-9_.$ -]{1,80}\*?$/;

/** The services of a target, trimmed, empty ones and repeats dropped. */
export function serviceNames(target: string): string[] {
  return [
    ...new Set(
      target
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
}

export const SEVERITIES: MonitorSeverity[] = ["info", "warning", "critical"];
export const SEVERITY_LABEL: Record<MonitorSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};
export const SEVERITY_TONE: Record<MonitorSeverity, string> = {
  info: "var(--th-status-info)",
  warning: "var(--th-status-warning)",
  critical: "var(--th-status-critical)",
};

/** The console's device categories (backend DEVICE_CATEGORIES): a "device type" policy follows these. */
export const DEVICE_CATEGORIES = [
  { value: "servers", label: "Servers" },
  { value: "clientpc", label: "Client PC" },
  { value: "network", label: "Network" },
  { value: "storage", label: "Storage" },
  { value: "hypervisors", label: "Hypervisors" },
  { value: "printers", label: "Printers" },
  { value: "iot", label: "IoT" },
  { value: "other", label: "Other" },
] as const;

/** Values older policies were saved with; the backend still maps them to a category. */
const LEGACY_CATEGORY: Record<string, string> = { server: "servers", client: "clientpc" };

/** The category a stored device-type value means ("server" → "servers"). */
export function categoryValue(value: string | null | undefined): string {
  if (!value) return "";
  return LEGACY_CATEGORY[value] ?? value;
}

export function categoryLabel(value: string | null | undefined): string | null {
  const category = categoryValue(value);
  return DEVICE_CATEGORIES.find((c) => c.value === category)?.label ?? null;
}

export const SCOPE_LABEL: Record<PolicyScope, string> = {
  default: "Every device",
  device_type: "Device category",
  client: "Client",
  group: "Group",
};

/** How specific a scope is: a device follows group > client > device type > default. */
export const SPECIFICITY: Record<PolicyScope, number> = { default: 0, device_type: 1, client: 2, group: 3 };

/** The key a new monitor of this metric gets, matching the seeded policies so it overrides theirs. */
const BASE_KEY: Record<MonitorMetric, string> = {
  cpu: "cpu",
  mem: "mem",
  disk: "disk",
  net_rx_mbps: "net_rx",
  net_tx_mbps: "net_tx",
  disk_forecast_days: "disk_forecast",
  no_data: "no_data",
  disk_busy: "disk_busy",
  gw_ms: "gw_latency",
  gw_loss: "gw_loss",
  service: "services",
  disk_health: "disk_health",
  critical_events: "critical_events",
  reboot_pending_days: "reboot_pending",
  security_score: "security",
};

/** What a new row of this metric starts with. */
const METRIC_DEFAULTS: Record<MonitorMetric, Pick<Monitor, "op" | "threshold" | "duration_s" | "severity">> = {
  cpu: { op: ">", threshold: 90, duration_s: 900, severity: "warning" },
  mem: { op: ">", threshold: 90, duration_s: 600, severity: "warning" },
  disk: { op: ">", threshold: 90, duration_s: 0, severity: "warning" },
  net_rx_mbps: { op: ">", threshold: 800, duration_s: 300, severity: "info" },
  net_tx_mbps: { op: ">", threshold: 800, duration_s: 300, severity: "info" },
  disk_forecast_days: { op: "<", threshold: 14, duration_s: 0, severity: "warning" },
  no_data: { op: ">", threshold: 0, duration_s: 600, severity: "critical" },
  disk_busy: { op: ">", threshold: 90, duration_s: 1200, severity: "info" },
  gw_ms: { op: ">", threshold: 150, duration_s: 600, severity: "info" },
  gw_loss: { op: ">", threshold: 20, duration_s: 600, severity: "warning" },
  service: { op: ">", threshold: 0, duration_s: 300, severity: "critical" },
  disk_health: { op: ">", threshold: 0, duration_s: 0, severity: "critical" },
  critical_events: { op: ">", threshold: 0, duration_s: 0, severity: "warning" },
  reboot_pending_days: { op: ">", threshold: 7, duration_s: 0, severity: "info" },
  security_score: { op: "<", threshold: 70, duration_s: 0, severity: "warning" },
};

/** A new service monitor's list: the usual server roles (services missing on a device are skipped). */
export const DEFAULT_SERVICES = "MSSQL*, SQLAgent*, vmms, NTDS, DNS, DHCPServer, LanmanServer, W32Time";

const PERCENT_METRICS = new Set<MonitorMetric>(["cpu", "mem", "disk", "disk_busy", "gw_loss"]);
const KEY_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface MonitorDraft {
  /** Local row id for React; never sent. */
  rowId: number;
  key: string;
  metric: MonitorMetric;
  op: ">" | "<";
  threshold: string;
  durationMin: string;
  severity: MonitorSeverity;
  enabled: boolean;
  /** Service monitors: the services to watch. */
  target: string;
}

export interface PolicyDraft {
  name: string;
  description: string;
  scope: PolicyScope;
  scopeValue: string;
  enabled: boolean;
  sample: string;
  uploadMin: string;
  buffer: string;
  keepDays: string;
  monitors: MonitorDraft[];
}

let nextRowId = 1;

const num = (value: number) => String(+value.toFixed(2));

export function monitorToDraft(monitor: Monitor): MonitorDraft {
  return {
    rowId: nextRowId++,
    key: monitor.key,
    metric: monitor.metric,
    op: monitor.op,
    threshold: num(monitor.threshold),
    durationMin: num(monitor.duration_s / 60),
    severity: monitor.severity,
    enabled: monitor.enabled,
    target: monitor.target ?? "",
  };
}

export function toDraft(policy: PolicyBody): PolicyDraft {
  return {
    name: policy.name,
    description: policy.description ?? "",
    scope: policy.scope,
    scopeValue: policy.scope_value ?? "",
    enabled: policy.enabled,
    sample: String(policy.sample_seconds),
    uploadMin: num(policy.upload_seconds / 60),
    buffer: String(policy.buffer_mb),
    keepDays: String(policy.keep_days),
    monitors: policy.monitors.map(monitorToDraft),
  };
}

/** A new policy's settings before the operator changes them (the backend's defaults). */
export function blankBody(name: string, description: string, scope: PolicyScope, scopeValue: string): PolicyBody {
  return {
    name: name.trim(),
    description: description.trim() || null,
    scope,
    scope_value: scope === "default" ? null : scopeValue,
    enabled: true,
    sample_seconds: 60,
    upload_seconds: 900,
    buffer_mb: 50,
    keep_days: 7,
    monitors: [],
  };
}

/** A key for a new monitor of `metric`: the seeded key when free, so it overrides a broader policy's. */
export function keyFor(metric: MonitorMetric, taken: string[]): string {
  const base = BASE_KEY[metric];
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i += 1) {
    const key = `${base}_${i}`;
    if (!taken.includes(key)) return key;
  }
}

export function newMonitor(metric: MonitorMetric, taken: string[]): MonitorDraft {
  return monitorToDraft({
    key: keyFor(metric, taken),
    metric,
    enabled: true,
    ...METRIC_DEFAULTS[metric],
    target: metric === "service" ? DEFAULT_SERVICES : null,
  });
}

/** A row switched to another metric takes that metric's defaults and, if it had one, its key. */
export function changeMetric(row: MonitorDraft, metric: MonitorMetric, taken: string[]): MonitorDraft {
  const keyWasAuto = row.key === BASE_KEY[row.metric] || row.key.startsWith(`${BASE_KEY[row.metric]}_`);
  const others = taken.filter((k) => k !== row.key);
  const defaults = METRIC_DEFAULTS[metric];
  return {
    ...row,
    metric,
    key: keyWasAuto ? keyFor(metric, others) : row.key,
    op: defaults.op,
    threshold: num(defaults.threshold),
    durationMin: num(defaults.duration_s / 60),
    target: metric === "service" ? row.target || DEFAULT_SERVICES : "",
  };
}

const toNumber = (value: string) => (value.trim() === "" ? NaN : Number(value));
const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const whole = (value: number, min: number, max: number) => Number.isInteger(value) && between(value, min, max);

export function toBody(draft: PolicyDraft): PolicyBody {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    scope: draft.scope,
    scope_value: draft.scope === "default" ? null : draft.scopeValue || null,
    enabled: draft.enabled,
    sample_seconds: toNumber(draft.sample),
    upload_seconds: Math.round(toNumber(draft.uploadMin) * 60),
    buffer_mb: toNumber(draft.buffer),
    keep_days: toNumber(draft.keepDays),
    monitors: draft.monitors.map((m) => {
      const shape = METRIC_SHAPE[m.metric];
      const monitor: Monitor = {
        key: m.key.trim(),
        metric: m.metric,
        op: shape.condition === "below" ? "<" : shape.condition === "op" ? m.op : ">",
        threshold: shape.condition === "none" || shape.condition === "service" ? 0 : toNumber(m.threshold),
        duration_s: shape.duration ? Math.round(toNumber(m.durationMin) * 60) : 0,
        severity: m.severity,
        enabled: m.enabled,
      };
      if (m.metric === "service") monitor.target = serviceNames(m.target).join(", ");
      return monitor;
    }),
  };
}

export type MonitorField = "key" | "threshold" | "duration" | "target";

export interface DraftProblems {
  name?: string;
  scopeValue?: string;
  sample?: string;
  uploadMin?: string;
  buffer?: string;
  keepDays?: string;
  /** By row id. */
  monitors: Record<number, Partial<Record<MonitorField, string>>>;
  /** Every problem in reading order; the first is shown next to the save button. */
  list: string[];
}

function thresholdProblem(metric: MonitorMetric, value: number): string | null {
  const shape = METRIC_SHAPE[metric].condition;
  if (shape === "none" || shape === "service") return null;
  if (PERCENT_METRICS.has(metric)) return between(value, 1, 100) ? null : "a threshold between 1 and 100%";
  if (metric === "disk_forecast_days" || metric === "reboot_pending_days")
    return whole(value, 1, 365) ? null : "a whole number of days between 1 and 365";
  if (metric === "critical_events") return whole(value, 0, 1000) ? null : "a whole number of events, 0 or more";
  if (metric === "security_score") return whole(value, 1, 100) ? null : "a score between 1 and 100";
  if (metric === "gw_ms") return between(value, 1, 60000) ? null : "a latency between 1 and 60,000 ms";
  return between(value, 1, 100000) ? null : "a threshold between 1 and 100,000 Mb/s";
}

function targetProblem(target: string): string | null {
  const names = serviceNames(target);
  if (!names.length) return "name at least one service";
  const bad = names.find((n) => !SERVICE_NAME.test(n));
  if (bad) return `"${bad}" is not a service name`;
  if (names.join(", ").length > 512) return "the service list is too long";
  return null;
}

export function validate(draft: PolicyDraft): DraftProblems {
  const problems: DraftProblems = { monitors: {}, list: [] };
  const add = (field: Exclude<keyof DraftProblems, "monitors" | "list">, message: string) => {
    problems[field] = message;
    problems.list.push(message);
  };
  if (!draft.name.trim()) add("name", "Give the policy a name.");
  else if (draft.name.trim().length > 120) add("name", "Keep the name under 120 characters.");
  if (draft.scope !== "default" && !draft.scopeValue) {
    const what = draft.scope === "device_type" ? "category" : draft.scope;
    add("scopeValue", `Choose the ${what} this policy applies to.`);
  }
  if (!whole(toNumber(draft.sample), LIMITS.sample.min, LIMITS.sample.max))
    add("sample", `Sample every ${LIMITS.sample.min}–${LIMITS.sample.max} seconds.`);
  const upload = toNumber(draft.uploadMin) * 60;
  if (!between(upload, 60, 3600))
    add("uploadMin", `Upload every ${LIMITS.uploadMin.min}–${LIMITS.uploadMin.max} minutes.`);
  if (!whole(toNumber(draft.buffer), LIMITS.buffer.min, LIMITS.buffer.max))
    add("buffer", `Buffer ${LIMITS.buffer.min}–${LIMITS.buffer.max} MB on the device.`);
  if (!whole(toNumber(draft.keepDays), LIMITS.keepDays.min, LIMITS.keepDays.max))
    add("keepDays", `Keep unsent data ${LIMITS.keepDays.min}–${LIMITS.keepDays.max} days.`);

  if (draft.monitors.length > LIMITS.monitors)
    problems.list.push(`A policy holds at most ${LIMITS.monitors} monitors.`);
  const seen = new Set<string>();
  draft.monitors.forEach((m, index) => {
    const row: Partial<Record<MonitorField, string>> = {};
    const label = `Monitor ${index + 1}`;
    const key = m.key.trim();
    if (!KEY_PATTERN.test(key)) row.key = `${label}: the key uses a–z, 0–9 and _ (up to 32).`;
    else if (seen.has(key)) row.key = `${label}: each monitor needs its own key.`;
    seen.add(key);
    const threshold = thresholdProblem(m.metric, toNumber(m.threshold));
    if (threshold) row.threshold = `${label}: ${threshold}.`;
    if (METRIC_SHAPE[m.metric].duration && !between(toNumber(m.durationMin), 0, LIMITS.durationMin.max))
      row.duration = `${label}: duration 0–${LIMITS.durationMin.max} minutes.`;
    if (m.metric === "service") {
      const target = targetProblem(m.target);
      if (target) row.target = `${label}: ${target}.`;
    }
    if (Object.keys(row).length) {
      problems.monitors[m.rowId] = row;
      problems.list.push(...(Object.values(row) as string[]));
    }
  });
  return problems;
}

/** The draft with row ids dropped, to tell whether anything changed. */
export function fingerprint(draft: PolicyDraft): string {
  return JSON.stringify({ ...draft, monitors: draft.monitors.map(({ rowId: _rowId, ...rest }) => rest) });
}

const monitorPrint = ({ rowId: _rowId, ...rest }: MonitorDraft) => JSON.stringify(rest);

/**
 * How many things differ from what was published: each changed field counts
 * once (the scope and its value together), and each added, removed or edited
 * monitor once.
 */
export function countChanges(base: PolicyDraft, draft: PolicyDraft): number {
  let n = 0;
  const fields = ["name", "description", "enabled", "sample", "uploadMin", "buffer", "keepDays"] as const;
  for (const field of fields) if (base[field] !== draft[field]) n += 1;
  if (base.scope !== draft.scope || base.scopeValue !== draft.scopeValue) n += 1;
  const before = new Map(base.monitors.map((m) => [m.rowId, monitorPrint(m)]));
  const after = new Set<number>();
  for (const m of draft.monitors) {
    after.add(m.rowId);
    const was = before.get(m.rowId);
    if (was === undefined || was !== monitorPrint(m)) n += 1;
  }
  for (const rowId of before.keys()) if (!after.has(rowId)) n += 1;
  // Moving a monitor without changing it still changes what is published.
  if (n === 0 && fingerprint(base) !== fingerprint(draft)) n = 1;
  return n;
}

// ── plain words ──────────────────────────────────────────────────────────────

export interface ScopeNames {
  clients: Client[];
  groups: DeviceGroup[];
}

export function scopeTarget(scope: PolicyScope, value: string | null | undefined, names: ScopeNames): string {
  if (scope === "default") return "Every device";
  if (scope === "device_type") {
    const label = categoryLabel(value);
    return label ? `${label} category` : `Category ${value ?? "not set"}`;
  }
  if (scope === "client") {
    const client = names.clients.find((c) => String(c.id) === value);
    return `Client: ${client?.name ?? `#${value}`}`;
  }
  const group = names.groups.find((g) => String(g.id) === value);
  if (!group) return `Group: #${value}`;
  const client = names.clients.find((c) => c.id === group.client_id);
  return `Group: ${client ? `${client.name} › ` : ""}${group.name}`;
}

/** "Default · every device", "Servers category", "Client: Northwind". */
export function scopeWords(policy: Pick<PolicyBody, "scope" | "scope_value">, names: ScopeNames): string {
  if (policy.scope === "default") return "Default · every device";
  return scopeTarget(policy.scope, policy.scope_value, names);
}

export function monitorCount(policy: Pick<PolicyBody, "monitors">): string {
  const n = policy.monitors.length;
  return `${n} monitor${n === 1 ? "" : "s"}`;
}

/** The agent release that first reports which policy version it runs. */
export const REPORTING_AGENT = "2.1.29";

export type CoverageTone = "online" | "warning" | "muted";

export const COVERAGE_TONE: Record<CoverageTone, string> = {
  online: "var(--th-status-online)",
  warning: "var(--th-status-warning)",
  muted: "var(--th-text-faint)",
};

/**
 * A policy's coverage, honestly: only agents 2.1.29+ report the version they
 * run, so the claim is made about those, and the rest are named apart.
 * "4 of 4 reporting agents on v1" · "3 of 4 on v1 · 1 behind" ·
 * "925 on older agents (update to 2.1.29 to report)".
 */
export function coverageWords(
  policy: Pick<MonitoringPolicy, "enabled" | "version" | "devices" | "devices_current" | "devices_reporting">,
): { text: string; tone: CoverageTone; older: string | null } {
  if (!policy.enabled) return { text: "Off · not sent to devices", tone: "muted", older: null };
  if (!policy.devices) return { text: "No devices in scope", tone: "muted", older: null };
  const reporting = Math.min(policy.devices_reporting ?? 0, policy.devices);
  const current = Math.min(policy.devices_current, reporting);
  const olderCount = policy.devices - reporting;
  const older =
    olderCount > 0 ? `${formatCount(olderCount)} on older agents (update to ${REPORTING_AGENT} to report)` : null;
  const v = `v${policy.version}`;
  if (!reporting) return { text: "No agent reports its version yet", tone: "muted", older };
  if (current >= reporting)
    return {
      text: `${formatCount(current)} of ${formatCount(reporting)} reporting agent${reporting === 1 ? "" : "s"} on ${v}`,
      tone: "online",
      older,
    };
  return {
    text: `${formatCount(current)} of ${formatCount(reporting)} on ${v} · ${formatCount(reporting - current)} behind`,
    tone: "warning",
    older,
  };
}

/** The broader policies a monitor key would replace on a device this policy covers. */
export function overriddenBy(policy: Pick<MonitoringPolicy, "id" | "scope">, all: MonitoringPolicy[], key: string) {
  return all
    .filter(
      (p) =>
        p.id !== policy.id &&
        p.enabled &&
        SPECIFICITY[p.scope] < SPECIFICITY[policy.scope] &&
        p.monitors.some((m) => m.key === key),
    )
    .map((p) => p.name);
}

export function devicesWord(n: number): string {
  return `${formatCount(n)} device${n === 1 ? "" : "s"}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
