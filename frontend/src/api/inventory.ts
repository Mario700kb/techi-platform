import { fetchJson } from "./client";

export interface ProcessInfo {
  pid: number;
  name: string;
  memory_mb?: number | null;
}

export interface ServiceInfo {
  name: string;
  display_name: string;
  status: string;
  startup_type?: string | null;
}

export interface SoftwareInfo {
  name: string;
  version?: string | null;
  publisher?: string | null;
  install_date?: string | null;
}

export interface DeviceInventory {
  device_id: number;
  processes: ProcessInfo[];
  services: ServiceInfo[];
  software: SoftwareInfo[];
  pending_updates?: number | null;
  reboot_required: boolean;
  last_update_at?: string | null;
  patch_state: PatchState;
  collected_at?: string | null;
}

export type PatchState = "up_to_date" | "updates_available" | "reboot_required" | "unknown";

export interface PatchStatus {
  device_id: number;
  pending_updates?: number | null;
  reboot_required: boolean;
  last_update_at?: string | null;
  patch_state: PatchState;
}

export async function getDeviceInventory(deviceId: number): Promise<DeviceInventory> {
  return fetchJson<DeviceInventory>(`/api/v1/devices/${deviceId}/inventory`);
}

export async function getDevicesPatchStatus(): Promise<PatchStatus[]> {
  return fetchJson<PatchStatus[]>("/api/v1/devices/patch-status");
}
