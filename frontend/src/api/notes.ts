import { fetchJson } from "./client";

export interface DeviceNote {
  id: number;
  device_id: number;
  note: string;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export async function getDeviceNotes(deviceId: number, limit = 50): Promise<DeviceNote[]> {
  return fetchJson<DeviceNote[]>(`/api/v1/devices/${deviceId}/notes?limit=${limit}`);
}

export async function createDeviceNote(deviceId: number, note: string): Promise<DeviceNote> {
  return fetchJson<DeviceNote>(`/api/v1/devices/${deviceId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, created_by: "admin" }),
  });
}

export async function updateDeviceNote(deviceId: number, noteId: number, note: string): Promise<DeviceNote> {
  return fetchJson<DeviceNote>(`/api/v1/devices/${deviceId}/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
}

export async function deleteDeviceNote(deviceId: number, noteId: number): Promise<DeviceNote> {
  return fetchJson<DeviceNote>(`/api/v1/devices/${deviceId}/notes/${noteId}`, {
    method: "DELETE",
  });
}

