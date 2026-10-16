import { fetchJson } from "./client";

export interface ReenrollmentRequest {
  id: number;
  device_id: number;
  device_hostname: string | null;
  new_device_id: number | null;
  agent_id: string;
  matched_by: string;
  status: string;
  hostname: string | null;
  current_user: string | null;
  domain: string | null;
  local_ip: string | null;
  public_ip: string | null;
  rustdesk_id: string | null;
  os_caption: string | null;
  platform: string | null;
  token_name: string | null;
  created_at: string;
  last_seen_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision: string | null;
}

export async function listReenrollmentRequests(status = "pending"): Promise<ReenrollmentRequest[]> {
  return fetchJson<ReenrollmentRequest[]>(`/api/v1/reenrollment-requests?status=${encodeURIComponent(status)}`);
}

export async function approveReenrollment(id: number): Promise<ReenrollmentRequest> {
  return fetchJson<ReenrollmentRequest>(`/api/v1/reenrollment-requests/${id}/approve`, { method: "POST" });
}

export async function rejectReenrollment(id: number): Promise<ReenrollmentRequest> {
  return fetchJson<ReenrollmentRequest>(`/api/v1/reenrollment-requests/${id}/reject`, { method: "POST" });
}
