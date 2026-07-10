import { describe, expect, it } from "vitest";

import { hasStructuralConnectMethod } from "../DevicesTable";
import type { Device } from "../../api/devices";

// Production bug fix: the Device Catalog Connect button used the Windows-
// only RustDesk check (rustdesk_id + no conflict) for EVERY platform, so
// non-Windows devices — which never have a rustdesk_id — always showed a
// permanently grey, unexplained Connect button even though they have real
// Connect Framework methods (SSH/Winbox/WebFig/Terminal) available via the
// Drawer. hasStructuralConnectMethod() is the cheap, per-row-safe check that
// replaces the RustDesk check for non-Windows rows.

function device(overrides: Partial<Device> = {}): Device {
  return { id: 1, hostname: "d1", ...overrides } as Device;
}

describe("hasStructuralConnectMethod", () => {
  it("returns false for Windows (handled by the separate RustDesk check)", () => {
    expect(hasStructuralConnectMethod(device({ platform: "windows" }))).toBe(false);
    expect(hasStructuralConnectMethod(device({ platform: undefined }))).toBe(false);
  });

  it("MikroTik is always connectable (Winbox/WebFig are native, capability-less methods)", () => {
    expect(hasStructuralConnectMethod(device({ platform: "mikrotik", capabilities: undefined }))).toBe(true);
    expect(hasStructuralConnectMethod(device({ platform: "mikrotik", capabilities: {} }))).toBe(true);
  });

  it("Synology/QNAP/VMware/Proxmox/Hyper-V are always connectable via their native method", () => {
    for (const platform of ["synology", "qnap", "vmware", "proxmox", "hyperv"]) {
      expect(hasStructuralConnectMethod(device({ platform }))).toBe(true);
    }
  });

  it("Linux needs at least one reported capability — none reported means no method", () => {
    expect(hasStructuralConnectMethod(device({ platform: "linux", capabilities: {} }))).toBe(false);
    expect(hasStructuralConnectMethod(device({ platform: "linux", capabilities: undefined }))).toBe(false);
  });

  it("Linux with a reported capability (e.g. terminal) is connectable", () => {
    expect(hasStructuralConnectMethod(device({ platform: "linux", capabilities: { terminal: "" } }))).toBe(true);
  });

  it("is case-insensitive on platform", () => {
    expect(hasStructuralConnectMethod(device({ platform: "MikroTik" }))).toBe(true);
    expect(hasStructuralConnectMethod(device({ platform: "WINDOWS" }))).toBe(false);
  });
});
