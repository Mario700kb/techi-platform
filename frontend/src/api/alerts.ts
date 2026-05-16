import { fetchJson } from "./client";
import { Alert, AlertCount } from "../types/alert";

export function getAlerts(params?: { state?: "open" | "resolved"; limit?: number; offset?: number }): Promise<Alert[]> {
  const qs = new URLSearchParams();
  if (params?.state) qs.set("state", params.state);
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/${query}`);
}

export function getAlertCount(): Promise<AlertCount> {
  return fetchJson<AlertCount>("/api/v1/alerts/count");
}

export function getDeviceAlerts(deviceId: number, state?: "open" | "resolved"): Promise<Alert[]> {
  const qs = state ? `?state=${state}` : "";
  return fetchJson<Alert[]>(`/api/v1/alerts/device/${deviceId}${qs}`);
}

export function resolveAlert(alertId: number): Promise<Alert> {
  return fetchJson<Alert>(`/api/v1/alerts/${alertId}/resolve`, { method: "PUT" });
}
