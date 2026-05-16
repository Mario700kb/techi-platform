import { fetchJson } from "./client";

export interface Client {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface DeviceGroup {
  id: number;
  client_id: number;
  name: string;
  description?: string | null;
  created_at: string;
}

export interface ClientCreate {
  name: string;
  slug?: string;
  description?: string;
  is_active?: boolean;
}

export interface ClientUpdate {
  name?: string;
  description?: string | null;
  is_active?: boolean;
}

export interface DeviceGroupCreate {
  name: string;
  client_id: number;
  description?: string;
}

export interface DeviceGroupUpdate {
  name?: string;
  description?: string | null;
}

export async function getClients(): Promise<Client[]> {
  return fetchJson<Client[]>("/api/v1/clients");
}

export async function createClient(payload: ClientCreate): Promise<Client> {
  return fetchJson<Client>("/api/v1/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateClient(clientId: number, payload: ClientUpdate): Promise<Client> {
  return fetchJson<Client>(`/api/v1/clients/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteClient(clientId: number): Promise<Client> {
  return fetchJson<Client>(`/api/v1/clients/${clientId}`, {
    method: "DELETE",
  });
}

export async function getGroups(clientId?: number): Promise<DeviceGroup[]> {
  const params = clientId ? `?client_id=${clientId}` : "";
  return fetchJson<DeviceGroup[]>(`/api/v1/groups${params}`);
}

export async function createGroup(payload: DeviceGroupCreate): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>("/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateGroup(groupId: number, payload: DeviceGroupUpdate): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>(`/api/v1/groups/${groupId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteGroup(groupId: number): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>(`/api/v1/groups/${groupId}`, {
    method: "DELETE",
  });
}
