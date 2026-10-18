import { apiFetch, fetchJson } from "./client";
import { saveBlob } from "../utils/download";

export type ReportFormat = "pdf" | "csv";
export type ReportCadence = "daily" | "weekly" | "monthly";
export type ReportStatus = "pending" | "completed" | "failed";
export type ReportScope = "client" | "device";
/** Device report categories (scope "device"). */
export type DeviceReportType =
  | "full"
  | "overview"
  | "user_activity"
  | "status_uptime"
  | "health"
  | "alerts"
  | "actions"
  | "software"
  | "remote_support"
  | "assignments"
  | "notes"
  | "event_history";
/** Client reports, one per catalog card (scope "client"). */
export type ClientReportKey =
  | "executive"
  | "patch_compliance"
  | "lifecycle"
  | "availability"
  | "capacity"
  | "access_audit"
  | "security_posture"
  | "full";
export type ReportType = DeviceReportType | ClientReportKey;

export interface GenerateReportPayload {
  scope_type?: ReportScope;
  client_id?: number;
  device_id?: number;
  report_type?: ReportType;
  report_format: ReportFormat;
  period_days?: number;
  period_from?: string;
  period_to?: string;
}

export interface ReportClient {
  id: number;
  name: string;
}

export interface ReportRun {
  id: number;
  schedule_id?: number | null;
  client_id: number | null;
  client_name: string;
  scope_type?: ReportScope;
  device_id?: number | null;
  device_name?: string | null;
  report_type?: ReportType;
  report_format: ReportFormat;
  period_start: string;
  period_end: string;
  status: ReportStatus;
  filename?: string | null;
  size_bytes?: number | null;
  error_message?: string | null;
  generated_by: string;
  created_at: string;
  completed_at?: string | null;
}

export interface ReportSchedule {
  id: number;
  name: string;
  client_id: number;
  client_name: string;
  /** Absent from servers older than the report catalog: those schedules are "full". */
  report_type?: ClientReportKey;
  report_format: ReportFormat;
  cadence: ReportCadence;
  period_days: number;
  hour_local: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  enabled: boolean;
  next_run_at: string;
  last_run_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SchedulePayload {
  name: string;
  client_id: number;
  report_type: ClientReportKey;
  report_format: ReportFormat;
  cadence: ReportCadence;
  period_days: number;
  hour_local: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  enabled?: boolean;
}

// ── Client report catalog and on-screen preview ──

export type ReportTone = "ok" | "warn" | "crit" | "info" | "neutral";
export type ReportColumnKind = "text" | "number" | "percent" | "date" | "datetime" | "duration" | "badge";
/** How a KPI value is formatted; "text" values are display-ready (e.g. "needs agent 2.1.31"). */
export type ReportKpiKind = "number" | "percent" | "duration" | "text";

export interface ReportCatalogEntry {
  key: ClientReportKey;
  title: string;
  description: string;
  formats: ReportFormat[];
  /** What the report depends on that not every device has yet (e.g. "agent 2.1.31"), or null. */
  needs: string | null;
  /** False: no on-screen preview (the original "full" report renders only to files). Absent means true. */
  preview?: boolean;
}

export interface ReportSummaryItem {
  label: string;
  value: string | number | null;
  /** How to format `value` (default "number"); a string value is shown as it is. */
  kind?: ReportKpiKind;
  hint?: string | null;
  tone?: ReportTone;
}

export interface ReportColumn {
  key: string;
  label: string;
  align: "left" | "right";
  kind: ReportColumnKind;
}

/** A cell value: JSON-native (numbers stay numbers, percent 0–100, durations in seconds, ISO dates). */
export type ReportCell = unknown;
/** One table row: cell values by column key (rows may carry keys no column shows), plus a tone and device link. */
export interface ReportRow {
  _tone?: ReportTone | null;
  _device_id?: number | null;
  [key: string]: unknown;
}

export interface ReportSection {
  key: string;
  title: string;
  description?: string | null;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Shown instead of the table when there are no rows. */
  empty?: string;
  note?: string | null;
}

/** A client report as data: what the PDF/CSV contain, rendered on screen. */
export interface ReportDocument {
  key: ClientReportKey | string;
  title: string;
  subtitle?: string | null;
  client_id: number;
  client_name: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  summary: ReportSummaryItem[];
  sections: ReportSection[];
  notes: string[];
}

export type ReportPeriod = { period_days: number } | { period_from: string; period_to: string };

export const getReportCatalog = () => fetchJson<ReportCatalogEntry[]>("/api/v1/reports/catalog");

export function getReportPreview(clientId: number, reportType: ClientReportKey, period: ReportPeriod) {
  const params = new URLSearchParams({ client_id: String(clientId), report_type: reportType });
  if ("period_days" in period) params.set("period_days", String(period.period_days));
  else {
    params.set("period_from", period.period_from);
    params.set("period_to", period.period_to);
  }
  return fetchJson<ReportDocument>(`/api/v1/reports/preview?${params.toString()}`);
}

export const getReportClients = () => fetchJson<ReportClient[]>("/api/v1/reports/clients");
export const getReportRuns = () => fetchJson<{ items: ReportRun[]; total: number }>("/api/v1/reports/runs?limit=100");
export const getReportSchedules = () => fetchJson<ReportSchedule[]>("/api/v1/reports/schedules");

export function generateReport(payload: GenerateReportPayload) {
  return fetchJson<ReportRun>("/api/v1/reports/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function createReportSchedule(payload: SchedulePayload) {
  return fetchJson<ReportSchedule>("/api/v1/reports/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The client of a schedule cannot change; the server ignores client_id on update. */
export function updateReportSchedule(id: number, payload: Partial<Omit<SchedulePayload, "client_id">>) {
  return fetchJson<ReportSchedule>(`/api/v1/reports/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteReportSchedule(id: number) {
  return apiFetch(`/api/v1/reports/schedules/${id}`, { method: "DELETE" }).then(() => undefined);
}

export function deleteReportRun(id: number) {
  return apiFetch(`/api/v1/reports/runs/${id}`, { method: "DELETE" }).then(() => undefined);
}

export async function downloadReport(run: ReportRun): Promise<void> {
  const response = await apiFetch(`/api/v1/reports/runs/${run.id}/download`);
  saveBlob(await response.blob(), run.filename || `techi-report-${run.id}.${run.report_format}`);
}
