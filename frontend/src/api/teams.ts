import { fetchJson } from "./client";

export interface TeamRecord {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  permissions: string[];
  created_at: string;
}

export interface TeamWithStats extends TeamRecord {
  member_count: number;
  client_count: number;
  group_count: number;
  explicit_device_count: number;
  effective_device_count: number;
  operator_ids: number[];
}

export interface TeamDetail extends TeamRecord {
  operator_ids: number[];
  client_ids: number[];
  group_ids: number[];
  device_ids: number[];
}

export interface TeamCreate {
  name: string;
  description?: string | null;
  color?: string | null;
  permissions?: string[] | null;
}

export interface TeamUpdate {
  name?: string;
  description?: string | null;
  color?: string | null;
  permissions?: string[] | null;
}

export async function listTeams(): Promise<TeamWithStats[]> {
  return fetchJson<TeamWithStats[]>("/api/v1/teams/");
}

export async function getTeam(id: number): Promise<TeamDetail> {
  return fetchJson<TeamDetail>(`/api/v1/teams/${id}`);
}

export async function createTeam(payload: TeamCreate): Promise<TeamDetail> {
  return fetchJson<TeamDetail>("/api/v1/teams/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateTeam(id: number, payload: TeamUpdate): Promise<TeamDetail> {
  return fetchJson<TeamDetail>(`/api/v1/teams/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteTeam(id: number): Promise<void> {
  await fetchJson<{ message: string }>(`/api/v1/teams/${id}`, {
    method: "DELETE",
  });
}

export async function updateTeamMembers(id: number, operatorIds: number[]): Promise<void> {
  await fetchJson<{ message: string }>(`/api/v1/teams/${id}/members`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operator_ids: operatorIds }),
  });
}

export async function updateTeamClientAccess(id: number, clientIds: number[]): Promise<void> {
  await fetchJson<{ message: string }>(`/api/v1/teams/${id}/client-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: clientIds }),
  });
}

export async function updateTeamGroupAccess(id: number, groupIds: number[]): Promise<void> {
  await fetchJson<{ message: string }>(`/api/v1/teams/${id}/group-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: groupIds }),
  });
}

export async function updateTeamDeviceAccess(id: number, deviceIds: number[]): Promise<void> {
  await fetchJson<{ message: string }>(`/api/v1/teams/${id}/device-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: deviceIds }),
  });
}

export async function updateTeamPermissions(id: number, permissions: string[]): Promise<TeamDetail> {
  return fetchJson<TeamDetail>(`/api/v1/teams/${id}/permissions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissions }),
  });
}
