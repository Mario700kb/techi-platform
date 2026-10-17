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
  "net_rx_mbps",
  "net_tx_mbps",
  "disk_forecast_days",
  "no_data",
];

/** Monitors the platform evaluates itself; the rest run on the device every sample. */
export const SERVER_METRICS = new Set<MonitorMetric>(["disk_forecast_days", "no_data"]);

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

export const DEVICE_TYPES = [
  { value: "server", label: "Server", every: "Every server" },
  { value: "client", label: "Client PC", every: "Every client PC" },
] as const;

export const SCOPE_LABEL: Record<PolicyScope, string> = {
  default: "Every device",
  device_type: "Device type",
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
};

const PERCENT_METRICS = new Set<MonitorMetric>(["cpu", "mem", "disk"]);
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
  return monitorToDraft({ key: keyFor(metric, taken), metric, enabled: true, ...METRIC_DEFAULTS[metric] });
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
    monitors: draft.monitors.map((m) => ({
      key: m.key.trim(),
      metric: m.metric,
      op: m.metric === "disk_forecast_days" ? "<" : m.op,
      threshold: m.metric === "no_data" ? 0 : toNumber(m.threshold),
      duration_s: m.metric === "disk_forecast_days" ? 0 : Math.round(toNumber(m.durationMin) * 60),
      severity: m.severity,
      enabled: m.enabled,
    })),
  };
}

export type MonitorField = "key" | "threshold" | "duration";

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
  if (metric === "no_data") return null;
  if (PERCENT_METRICS.has(metric)) return between(value, 1, 100) ? null : "a threshold between 1 and 100%";
  if (metric === "disk_forecast_days") return whole(value, 1, 365) ? null : "a whole number of days between 1 and 365";
  return between(value, 1, 100000) ? null : "a threshold between 1 and 100,000 Mb/s";
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
    const what = draft.scope === "device_type" ? "device type" : draft.scope;
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
    if (m.metric !== "disk_forecast_days" && !between(toNumber(m.durationMin), 0, LIMITS.durationMin.max))
      row.duration = `${label}: duration 0–${LIMITS.durationMin.max} minutes.`;
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

// ── plain words ──────────────────────────────────────────────────────────────

export interface ScopeNames {
  clients: Client[];
  groups: DeviceGroup[];
}

export function scopeTarget(scope: PolicyScope, value: string | null | undefined, names: ScopeNames): string {
  if (scope === "default") return "Every device";
  if (scope === "device_type") return DEVICE_TYPES.find((t) => t.value === value)?.every ?? `Device type ${value}`;
  if (scope === "client") {
    const client = names.clients.find((c) => String(c.id) === value);
    return `Client: ${client?.name ?? `#${value}`}`;
  }
  const group = names.groups.find((g) => String(g.id) === value);
  if (!group) return `Group: #${value}`;
  const client = names.clients.find((c) => c.id === group.client_id);
  return `Group: ${client ? `${client.name} › ` : ""}${group.name}`;
}

/** "Default · every device", "Every server", "Client: Northwind". */
export function scopeWords(policy: Pick<PolicyBody, "scope" | "scope_value">, names: ScopeNames): string {
  if (policy.scope === "default") return "Default · every device";
  return scopeTarget(policy.scope, policy.scope_value, names);
}

export function monitorCount(policy: Pick<PolicyBody, "monitors">): string {
  const n = policy.monitors.length;
  return `${n} monitor${n === 1 ? "" : "s"}`;
}

/** "36 / 38 on v5", and whether every device runs it. */
export function syncWords(policy: MonitoringPolicy): { text: string; current: boolean } {
  return {
    text: `${policy.devices_current} / ${policy.devices} on v${policy.version}`,
    current: policy.devices_current >= policy.devices,
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
