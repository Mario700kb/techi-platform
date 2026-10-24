import { fetchJson } from "./client";

export type AutomationScope = "default" | "client" | "group" | "device_type" | "devices";
export type AutomationSchedule = "once" | "daily" | "weekly" | "monthly";
export type AutomationRunStatus = "running" | "completed" | "halted" | "cancelled" | "window_closed";

export interface AutomationWave {
  wave: number;
  batch_id: string;
  device_ids: number[];
  started_at: string;
  settled_at: string | null;
  completed: number;
  failed: number;
  unfinished: number;
}

export interface AutomationRun {
  id: number;
  task_id: number;
  status: AutomationRunStatus;
  trigger: "schedule" | "manual";
  started_by?: string | null;
  started_at: string;
  finished_at?: string | null;
  next_wave_at?: string | null;
  waves: AutomationWave[];
  reason?: string | null;
}

export interface AutomationTaskBody {
  name: string;
  enabled: boolean;
  scope: AutomationScope;
  scope_value?: string | null;
  device_ids?: number[];
  excluded_client_ids: number[];
  excluded_device_ids?: number[];
  skip_maintenance: boolean;
  schedule: AutomationSchedule;
  /** UTC ISO; schedule "once" only. */
  run_at?: string | null;
  /** "HH:MM", Tirana; every other schedule. */
  time_of_day?: string | null;
  /** 0 = Monday. */
  weekday?: number | null;
  day_of_month?: number | null;
  window_minutes: number;
  /** In order; 0 = everything left (last only). */
  wave_sizes: number[];
  wave_wait_minutes: number;
  max_failure_percent: number;
}

export interface AutomationTask extends AutomationTaskBody {
  id: number;
  kind: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_by: string;
  created_at: string;
  last_run?: AutomationRun | null;
}

export interface AutomationPreview {
  needs_update: number;
  up_to_date_or_busy: number;
  first_wave: number;
  version?: string | null;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const getAutomationTasks = () => fetchJson<AutomationTask[]>("/api/v1/automation/tasks");
export const createAutomationTask = (body: AutomationTaskBody) =>
  fetchJson<AutomationTask>("/api/v1/automation/tasks", json("POST", body));
export const updateAutomationTask = (id: number, body: AutomationTaskBody) =>
  fetchJson<AutomationTask>(`/api/v1/automation/tasks/${id}`, json("PUT", body));
export const deleteAutomationTask = (id: number) =>
  fetchJson<void>(`/api/v1/automation/tasks/${id}`, { method: "DELETE" });
export const previewAutomationTask = (id: number) =>
  fetchJson<AutomationPreview>(`/api/v1/automation/tasks/${id}/preview`);
export const runAutomationTask = (id: number) =>
  fetchJson<AutomationRun>(`/api/v1/automation/tasks/${id}/run`, json("POST"));
export const getAutomationRuns = (id: number) => fetchJson<AutomationRun[]>(`/api/v1/automation/tasks/${id}/runs`);
export const cancelAutomationRun = (runId: number) =>
  fetchJson<AutomationRun>(`/api/v1/automation/runs/${runId}/cancel`, json("POST"));
