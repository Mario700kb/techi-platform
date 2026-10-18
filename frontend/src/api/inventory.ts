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
  /** Windows agents >= 2.1.31; null until the first report. */
  security_posture?: SecurityPosture | null;
  security_collected_at?: string | null;
}

/** Read-only security snapshot from the Windows agent; null = could not be read. */
export interface SecurityPosture {
  collected_at?: string | null;
  defender: {
    present: boolean;
    antivirus_enabled: boolean | null;
    realtime_enabled: boolean | null;
    signature_age_days: number | null;
  };
  third_party_av: string[];
  firewall: { domain: boolean | null; private: boolean | null; public: boolean | null };
  bitlocker: { system_drive: string; protection: "on" | "off" | "unknown"; encryption_percent: number | null };
  uac_enabled: boolean | null;
  secure_boot: boolean | null;
  local_admins: string[];
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
