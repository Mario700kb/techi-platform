import { apiFetch, fetchJson } from "./client";
import { saveBlob } from "../utils/download";

export type ReportFormat = "pdf" | "csv";
export type ReportCadence = "daily" | "weekly" | "monthly";
export type ReportStatus = "pending" | "completed" | "failed";
export type ReportScope = "client" | "device";
export type ReportType =
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
  report_format: ReportFormat;
  cadence: ReportCadence;
  period_days: number;
  hour_local: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  enabled?: boolean;
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

export function updateReportSchedule(id: number, payload: Partial<SchedulePayload>) {
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
