import { fetchJson } from "./client";
import type {
  Alert,
  AlertAnalysis,
  AlertCount,
  AlertDetail,
  AlertGroup,
  AlertKind,
  AlertMute,
  AlertPage,
  AlertSeverity,
  AlertView,
  DutyInfo,
  DutyShift,
  Finding,
  FindingsPage,
  HandoverItem,
  QualityReport,
  WaitingReason,
} from "../types/alert";

export function getAlerts(params?: {
  state?: "open" | "resolved";
  severity?: AlertSeverity;
  kind?: AlertKind;
  search?: string;
  clientId?: number;
  limit?: number;
  offset?: number;
}): Promise<Alert[]> {
  const qs = new URLSearchParams();
  if (params?.state) qs.set("state", params.state);
  if (params?.severity) qs.set("severity", params.severity);
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.search?.trim()) qs.set("search", params.search.trim());
  if (params?.clientId != null) qs.set("client_id", String(params.clientId));
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/${query}`);
}

export function getAlertCount(search?: string, clientId?: number): Promise<AlertCount> {
  const qs = new URLSearchParams();
  if (search?.trim()) qs.set("search", search.trim());
  if (clientId != null) qs.set("client_id", String(clientId));
  const query = qs.toString();
  return fetchJson<AlertCount>(`/api/v1/alerts/count${query ? `?${query}` : ""}`);
}

export function getDeviceAlerts(deviceId: number, state?: "open" | "resolved"): Promise<Alert[]> {
  const qs = state ? `?state=${state}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/device/${deviceId}${qs}`);
}

export type ManualResolution = "fixed" | "false_positive" | "expected" | "duplicate";

export function resolveAlert(alertId: number, resolution?: ManualResolution, note?: string): Promise<Alert> {
  return fetchJson<Alert>(
    `/api/v1/alerts/${alertId}/resolve`,
    send("PUT", resolution ? { resolution, note: note?.trim() || null } : undefined),
  );
}

// An analysis takes Claude 10–60 seconds; the server gives up at 120.
const AI_TIMEOUT_MS = 150_000;

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function query(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

export interface QueueParams {
  view: AlertView;
  priority?: number;
  severity?: AlertSeverity;
  kind?: string;
  issue?: string;
  clientId?: number;
  deviceId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export function getAlertQueue(p: QueueParams): Promise<AlertPage> {
  return fetchJson<AlertPage>(
    `/api/v1/alerts/queue${query({
      view: p.view,
      priority: p.priority,
      severity: p.severity,
      kind: p.kind,
      issue: p.issue,
      client_id: p.clientId,
      device_id: p.deviceId,
      search: p.search?.trim(),
      limit: p.limit,
      offset: p.offset,
    })}`,
  );
}

export function getAlertGroups(
  by: "issue" | "client" | "device",
  view: AlertView,
  search?: string,
): Promise<AlertGroup[]> {
  return fetchJson<AlertGroup[]>(`/api/v1/alerts/groups${query({ by, view, search: search?.trim() })}`);
}

export function getAlertDetail(alertId: number): Promise<AlertDetail> {
  return fetchJson<AlertDetail>(`/api/v1/alerts/${alertId}`);
}

export function takeAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/take`, send("POST"));
}

export function assignAlert(alertId: number, operatorId: number | null): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/assign`, send("POST", { operator_id: operatorId }));
}

export function snoozeAlert(
  alertId: number,
  body: { minutes?: number; until?: string; until_worse?: boolean },
): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/snooze`, send("POST", body));
}

export function unsnoozeAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/unsnooze`, send("POST"));
}

export function addAlertNote(alertId: number, text: string): Promise<void> {
  return fetchJson<void>(`/api/v1/alerts/${alertId}/notes`, send("POST", { text }));
}

export function waitAlert(alertId: number, reason: WaitingReason, note?: string): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/wait`, send("POST", { reason, note: note?.trim() || null }));
}

export function resumeAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/resume`, send("POST"));
}

export function getAlertOperators(): Promise<{ id: number; name: string }[]> {
  return fetchJson(`/api/v1/alerts/operators`);
}

export function getAlertHandover(): Promise<HandoverItem[]> {
  return fetchJson<HandoverItem[]>(`/api/v1/alerts/handover`);
}

export function getAlertDuty(): Promise<DutyInfo> {
  return fetchJson<DutyInfo>(`/api/v1/alerts/duty`);
}

export function addDutyShift(body: {
  starts_on: string;
  ends_on: string;
  operator_id: number;
  backup_operator_id?: number | null;
  note?: string | null;
}): Promise<DutyShift> {
  return fetchJson<DutyShift>(`/api/v1/alerts/duty`, send("POST", body));
}

export function removeDutyShift(shiftId: number): Promise<void> {
  return fetchJson<void>(`/api/v1/alerts/duty/${shiftId}`, send("DELETE"));
}

export type BulkAction = "take" | "assign" | "snooze" | "unsnooze" | "resolve" | "wait" | "resume";

export function bulkAlerts(body: {
  ids: number[];
  action: BulkAction;
  reason?: WaitingReason;
  operator_id?: number | null;
  minutes?: number;
  until_worse?: boolean;
  resolution?: ManualResolution;
  note?: string;
}): Promise<{ done: number[]; failed: number[] }> {
  return fetchJson(`/api/v1/alerts/bulk`, send("POST", body));
}

export function analyzeAlert(
  alertId: number,
  body: { language?: "sq" | "en"; force?: boolean } = {},
): Promise<AlertAnalysis> {
  return fetchJson<AlertAnalysis>(`/api/v1/alerts/${alertId}/analysis`, {
    ...send("POST", body),
    timeoutMs: AI_TIMEOUT_MS,
  });
}

export function analyzeAlertGroup(
  issue: string,
  body: { language?: "sq" | "en"; force?: boolean } = {},
): Promise<AlertAnalysis> {
  return fetchJson<AlertAnalysis>(`/api/v1/alerts/analysis/group`, {
    ...send("POST", { issue, ...body }),
    timeoutMs: AI_TIMEOUT_MS,
  });
}

export function rateAnalysis(analysisId: number, rating: 1 | -1): Promise<AlertAnalysis> {
  return fetchJson<AlertAnalysis>(`/api/v1/alerts/analysis/${analysisId}/rating`, send("POST", { rating }));
}

export function getAlertMutes(): Promise<AlertMute[]> {
  return fetchJson<AlertMute[]>(`/api/v1/alerts/mutes`);
}

export function createAlertMute(body: {
  device_id?: number | null;
  client_id?: number | null;
  kind?: string | null;
  fingerprint?: string | null;
  days?: number | null;
  reason: string;
  resolve_open?: boolean;
}): Promise<AlertMute> {
  return fetchJson<AlertMute>(`/api/v1/alerts/mutes`, send("POST", body));
}

export function removeAlertMute(muteId: number): Promise<void> {
  return fetchJson<void>(`/api/v1/alerts/mutes/${muteId}`, send("DELETE"));
}

export function getAlertFindings(type?: Finding["type"]): Promise<FindingsPage> {
  return fetchJson<FindingsPage>(`/api/v1/alerts/findings${query({ type })}`);
}

export function getAlertQuality(days = 7): Promise<QualityReport> {
  return fetchJson<QualityReport>(`/api/v1/alerts/quality${query({ days })}`);
}

export type { AlertKind };
