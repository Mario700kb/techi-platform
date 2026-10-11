import { fetchJson } from "./client";
import { Alert, AlertCount, AlertKind, AlertSeverity } from "../types/alert";

export function getAlerts(params?: {
  state?: "open" | "resolved";
  severity?: AlertSeverity;
  kind?: AlertKind;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Alert[]> {
  const qs = new URLSearchParams();
  if (params?.state) qs.set("state", params.state);
  if (params?.severity) qs.set("severity", params.severity);
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.search?.trim()) qs.set("search", params.search.trim());
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/${query}`);
}

export function getAlertCount(search?: string): Promise<AlertCount> {
  const qs = search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
  return fetchJson<AlertCount>(`/api/v1/alerts/count${qs}`);
}

export function getDeviceAlerts(deviceId: number, state?: "open" | "resolved"): Promise<Alert[]> {
  const qs = state ? `?state=${state}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/device/${deviceId}${qs}`);
}

export function resolveAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/resolve`, { method: "PUT" });
}
