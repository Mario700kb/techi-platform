import type { Device } from "../api/devices";

export function deviceDisplayName(device: Device): string {
  return device.display_name?.trim() || device.hostname || "Unknown";
}

export function deviceHostnameSubtitle(device: Device): string | null {
  const displayName = device.display_name?.trim();
  if (!displayName || !device.hostname || displayName === device.hostname) return null;
  return device.hostname;
}
