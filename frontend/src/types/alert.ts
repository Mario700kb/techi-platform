export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "open" | "resolved";
export type AlertKind =
  | "device_offline"
  | "repeated_reconnects"
  | "high_cpu"
  | "high_ram"
  | "low_disk"
  | "disk_forecast"
  | "high_network"
  | "rustdesk_sync_failure"
  | "heartbeat_stale"
  | "telemetry_missing"
  | "archived_checkin"
  | "disk_busy"
  | "network_latency"
  | "packet_loss"
  | "service_stopped"
  | "disk_health"
  | "critical_events"
  | "reboot_pending"
  | "security_posture"
  | "token_usage_warning"
  | "token_usage_critical"
  | "site_outage";

/** 1 act now · 2 today · 3 when there is time · 4 whenever. */
export type AlertPriority = 1 | 2 | 3 | 4;
export type AlertResolution = "auto" | "fixed" | "false_positive" | "expected" | "duplicate" | "muted";
export type AlertView = "needs_action" | "mine" | "overdue" | "open" | "snoozed" | "resolved";
export type WaitingReason = "client" | "vendor" | "parts" | "maintenance";
/** Past a deadline, or the clock stopped while waiting on someone else. */
export type SlaState = "ack_overdue" | "overdue" | "waiting";

export interface Alert {
  id: number;
  // null for synthetic token-usage alerts (negative id, token_id set)
  device_id: number | null;
  token_id?: number | null;
  kind: AlertKind;
  severity: AlertSeverity;
  state: AlertState;
  message: string;
  detail?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  acknowledged_at?: string | null;
  cooldown_until?: string | null;
  // The device's current name and client (the message keeps the hostname it
  // had when the alert opened).
  device_name?: string | null;
  client_name?: string | null;
  client_id?: number | null;
  // The work queue.
  fingerprint?: string;
  occurrences?: number;
  last_seen_at?: string | null;
  priority?: AlertPriority | null;
  assigned_to_id?: number | null;
  assigned_to_name?: string | null;
  snoozed_until?: string | null;
  snooze_until_worse?: boolean;
  resolution?: AlertResolution | null;
  resolved_by?: string | null;
  // Plain words from the server (title, one-line summary, measured value).
  title?: string | null;
  summary?: string | null;
  value?: string | null;
  device_role?: "server" | "pc" | "site" | null;
  /** A site outage: the device alerts it groups. */
  member_ids?: number[] | null;
  // Deadlines: when it must be taken and fixed (naive UTC from the server).
  ack_due_at?: string | null;
  resolve_due_at?: string | null;
  /** A P1 on a server: the clock counts every hour, not working hours. */
  sla_24x7?: boolean;
  sla_step?: number;
  sla_state?: SlaState | null;
  first_action_at?: string | null;
  waiting_reason?: WaitingReason | null;
  waiting_since?: string | null;
  /** The incident lead this alert follows, or how many alerts follow it. */
  parent_id?: number | null;
  followers?: number;
  /** Came back 5 times in 7 days or after a fix: closing it needs the cause. */
  recurring?: boolean;
}

export interface AlertPage {
  items: Alert[];
  total: number;
}

export interface AlertGroup {
  key: string;
  label: string | null;
  title: string | null;
  kind: string | null;
  fingerprint: string;
  client_id: number | null;
  device_id: number | null;
  count: number;
  devices: number;
  priority: AlertPriority;
  critical: number;
  latest: string | null;
}

export interface AlertActivity {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  detail: string | null;
}

export type CommandRisk = "none" | "read_only" | "changes_settings" | "needs_restart" | "data_risk";

export interface RunbookCommand {
  label: string;
  script: string;
  risk: CommandRisk;
}

export interface Runbook {
  key: string;
  why: string;
  steps: string[];
  commands: RunbookCommand[];
  escalate: string | null;
}

export interface AnalysisStep {
  step: string;
  command: string;
  risk: CommandRisk;
}

export interface AnalysisResult {
  summary: string;
  likely_causes: { cause: string; confidence: "high" | "medium" | "low"; evidence: string }[];
  diagnostic_steps: AnalysisStep[];
  fix_steps: AnalysisStep[];
  verify: string;
  escalate_when: string;
  missing_information: string[];
}

export interface AlertAnalysis {
  id: number;
  alert_id: number | null;
  group_key: string | null;
  language: "sq" | "en";
  model: string;
  created_at: string;
  created_by: string | null;
  result: AnalysisResult | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  rating: 1 | -1 | null;
  cached: boolean;
  stale: boolean;
}

export interface HealthEventEvidence {
  at: string;
  source: string;
  event_id: number;
  title: string | null;
  message: string | null;
  counts: boolean;
}

export interface AlertDetail {
  alert: Alert;
  description: string;
  facts: Record<string, unknown>;
  evidence: {
    events?: HealthEventEvidence[];
    also_seen_7d?: string[];
    disks?: Record<string, unknown>[] | null;
    findings?: string[];
    posture_score?: number;
    series?: {
      at: string;
      cpu_avg: number | null;
      cpu_max: number | null;
      mem_avg: number | null;
      mem_max: number | null;
    }[];
    top_processes?: { n: string; c?: number | null; m?: number | null }[] | null;
    site?: { offline: number; devices: number };
    reboot_reasons?: string[];
    [key: string]: unknown;
  };
  history: string[];
  activity: AlertActivity[];
  runbook: Runbook | null;
  analysis: AlertAnalysis | null;
  ai_enabled: boolean;
  incident?: {
    lead_id: number;
    lead_device: string | null;
    followers: { id: number; device_id: number; device_name: string | null }[];
  } | null;
}

export interface AlertMute {
  id: number;
  device_id: number | null;
  device_name: string | null;
  client_id: number | null;
  client_name: string | null;
  kind: string | null;
  fingerprint: string | null;
  until: string | null;
  reason: string;
  created_by: string | null;
  created_at: string;
  closed?: number;
}

export interface Finding {
  device_id: number;
  device_name: string;
  client_name: string | null;
  device_role: "server" | "pc";
  type: "security" | "reboot" | "power" | "disk_forecast";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string | null;
  since: string | null;
}

export interface FindingsPage {
  items: Finding[];
  counts: Record<string, number>;
}

export interface QualityRow {
  issue: string;
  title: string;
  opened: number;
  reopened: number;
  devices: number;
  flapping: number;
  false_positive: number;
  expected: number;
  still_open: number;
  mtta_minutes: number | null;
  mttr_minutes: number | null;
  noise_pct: number;
}

export interface DeadlinePriorityRow {
  priority: AlertPriority;
  alerts: number;
  owned_pct: number | null;
  mtta_minutes: number | null;
  mttr_minutes: number | null;
  ack_met_pct: number | null;
  met_pct: number | null;
  overdue_open: number;
}

export interface DeadlineReport {
  by_priority: DeadlinePriorityRow[];
  by_person: { name: string; resolved: number; mttr_minutes: number | null; met_pct: number | null }[];
  urgent_owned_pct: number | null;
  fixed: number;
  fix_failed: number;
  fix_failed_pct: number | null;
}

export interface QualityReport {
  days: number;
  since: string;
  rows: QualityRow[];
  totals: { opened: number; noise_pct: number; issues: number };
  deadlines?: DeadlineReport | null;
}

export interface DutyShift {
  id: number;
  starts_on: string;
  ends_on: string;
  operator_id: number;
  operator_name: string | null;
  backup_operator_id: number | null;
  backup_name: string | null;
  note: string | null;
  created_by: string | null;
}

export interface DutyInfo {
  today: string;
  current: DutyShift | null;
  shifts: DutyShift[];
  deadlines: {
    priority: AlertPriority;
    ack_minutes: number | null;
    resolve_minutes: number;
    round_the_clock_on_servers: boolean;
  }[];
  work_hours: { days?: number[]; start?: string; end?: string; zone?: string };
}

export interface HandoverItem {
  id: number;
  priority: AlertPriority;
  title: string;
  device_name: string;
  client_name: string | null;
  owner: string | null;
  ack_due_at: string | null;
  resolve_due_at: string | null;
  sla_state: SlaState | null;
  waiting_reason: WaitingReason | null;
  last_note: string | null;
}

export const WAITING_LABELS: Record<WaitingReason, string> = {
  client: "Waiting on the client",
  vendor: "Waiting on a vendor",
  parts: "Waiting on a part",
  maintenance: "Waiting for a maintenance window",
};

export interface AlertCount {
  total_open: number;
  by_severity: Record<string, number>;
  by_kind?: Record<string, number>;
  devices_affected?: number;
  oldest_open_at?: string | null;
  views?: Partial<Record<Exclude<AlertView, "resolved"> | "waiting", number>>;
  by_priority?: Record<string, number>;
}

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  device_offline: "Device offline",
  repeated_reconnects: "Repeated reconnects",
  high_cpu: "High CPU",
  high_ram: "High memory",
  low_disk: "Low disk space",
  disk_forecast: "Disk full forecast",
  high_network: "High network",
  rustdesk_sync_failure: "Remote Support sync failed",
  heartbeat_stale: "Heartbeat stale",
  telemetry_missing: "Telemetry missing",
  archived_checkin: "Archived device checked in",
  disk_busy: "Disk busy",
  network_latency: "Slow network",
  packet_loss: "Packet loss",
  service_stopped: "Service stopped",
  disk_health: "Disk failing",
  critical_events: "Critical Windows events",
  reboot_pending: "Restart pending",
  security_posture: "Protection turned off",
  token_usage_warning: "Enrollment token nearly used up",
  token_usage_critical: "Enrollment token used up",
  site_outage: "Site offline",
};

export const PRIORITY_TONE: Record<AlertPriority, string> = {
  1: "var(--th-status-critical)",
  2: "var(--th-status-warning)",
  3: "var(--th-status-info)",
  4: "var(--th-text-muted)",
};

export const PRIORITY_HINT: Record<AlertPriority, string> = {
  1: "Act now",
  2: "Today",
  3: "When there is time",
  4: "Whenever",
};

export const RESOLUTION_LABELS: Record<AlertResolution, string> = {
  auto: "Closed by itself",
  fixed: "Fixed",
  false_positive: "False alarm",
  expected: "Expected",
  duplicate: "Duplicate",
  muted: "Muted",
};

export const RISK_LABELS: Record<CommandRisk, string> = {
  none: "No command",
  read_only: "Read-only",
  changes_settings: "Changes settings",
  needs_restart: "Needs restart",
  data_risk: "Data risk",
};

export const RISK_TONE: Record<CommandRisk, string> = {
  none: "var(--th-text-muted)",
  read_only: "var(--th-status-online)",
  changes_settings: "var(--th-status-info)",
  needs_restart: "var(--th-status-warning)",
  data_risk: "var(--th-status-critical)",
};

export const ALERT_SEVERITY_TONE: Record<AlertSeverity, string> = {
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
};
