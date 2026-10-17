// Which drawer renders a device. Windows (and a device with no platform,
// which the backend treats as Windows) always gets the classic DeviceDrawer:
// it owns the Windows-only sections — Remote Support, Maintenance with the
// administrator PowerShell — even now that Windows agents from 2.1.29 report a
// capability ("powershell"). Other platforms that report capabilities get the
// registry-driven GenericDeviceDrawer.
export function usesRegistryDrawer(device: {
  platform?: string | null;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform.startsWith("windows")) return false;
  return Boolean(device.capabilities && Object.keys(device.capabilities).length > 0);
}
