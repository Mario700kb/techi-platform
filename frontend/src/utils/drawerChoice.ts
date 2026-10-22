// Which drawer renders a device. Windows (and a device with no platform,
// which the backend treats as Windows) and Linux get the classic DeviceDrawer:
// Remote Support, Maintenance with the administrator console (PowerShell on
// Windows, the root terminal on Linux — owner's call, 22 Oct 2026). Other
// platforms that report capabilities (MikroTik, NAS, …) get the
// registry-driven GenericDeviceDrawer.
export function usesRegistryDrawer(device: {
  platform?: string | null;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform.startsWith("windows") || platform.startsWith("linux")) return false;
  return Boolean(device.capabilities && Object.keys(device.capabilities).length > 0);
}
