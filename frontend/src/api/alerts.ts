import { fetchJson } from "./client";
import { Alert, AlertCount, AlertKind, AlertSeverity } from "../types/alert";

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

export function resolveAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/resolve`, { method: "PUT" });
}
