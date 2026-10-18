import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeviceDrawer from "../DeviceDrawer";
import type { Device } from "../../api/devices";
import { appCache } from "../../store/appCache";

// Which (device, enabled) the drawer asks the live hook for on each render.
const liveCalls: [number | null | undefined, boolean][] = [];

vi.mock("../../hooks/useDeviceLive", () => ({
  useDeviceLive: (deviceId: number | null | undefined, enabled: boolean) => {
    liveCalls.push([deviceId, enabled]);
    return { state: "connecting", snapshot: null, receivedAt: null, intervalSeconds: 3, active: enabled };
  },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "owner" }, hasPermission: () => true, can: () => true }),
}));
vi.mock("../../api/devices", () => ({
  archiveDevice: vi.fn(),
  clearDeviceMaintenance: vi.fn(),
  enterDeviceMaintenance: vi.fn(),
  getDeviceOfflineAnalysis: vi.fn().mockResolvedValue({ reason: null, evidence: [] }),
  updateDevice: vi.fn(),
}));
vi.mock("../../api/actions", async (importActual) => ({
  ...(await importActual<typeof import("../../api/actions")>()),
  getDeviceActions: vi.fn().mockResolvedValue([]),
  getDeviceAgentChannel: vi.fn().mockResolvedValue({ connected: true }),
}));
vi.mock("../../api/notes", () => ({
  getDeviceNotes: vi.fn().mockResolvedValue([]),
  createDeviceNote: vi.fn(),
  deleteDeviceNote: vi.fn(),
  updateDeviceNote: vi.fn(),
}));
vi.mock("../../api/inventory", () => ({ getDeviceInventory: vi.fn().mockResolvedValue(null) }));
vi.mock("../../api/remoteSupport", () => ({
  getConnectUrl: vi.fn(),
  getRemoteSupportDevice: vi.fn().mockResolvedValue({}),
  getRemoteSupportPassword: vi.fn(),
  setRemoteSupportPassword: vi.fn(),
  regenerateRemoteSupportPassword: vi.fn(),
}));
vi.mock("../../hooks/useDeviceActivity", () => ({
  useDeviceActivity: () => ({ events: [], loading: false, reload: vi.fn() }),
}));
vi.mock("../../hooks/useDeviceAlerts", () => ({
  useDeviceAlerts: () => ({ openAlerts: [], resolvedAlerts: [] }),
}));
vi.mock("../../hooks/useDeviceTelemetry", () => ({
  useDeviceTelemetry: () => ({ snapshot: null, healthScore: 90, healthState: "healthy", healthReasons: [] }),
}));
vi.mock("../../hooks/usePlatformFeatures", () => ({
  usePlatformFeatures: () => ({ FEATURE_TERMINAL: false, FEATURE_PLATFORM_CORE: false, FEATURE_LINUX: false }),
}));
vi.mock("../ComponentStatesPanel", () => ({ default: () => null }));
vi.mock("../ConnectMenu", () => ({ default: () => null }));
vi.mock("../DeviceLast24hCard", () => ({ default: () => null }));
vi.mock("../DeviceMonitoringPanel", () => ({ default: () => null }));
vi.mock("../DevicePowerShellPanel", () => ({ default: () => null }));
vi.mock("../DeviceAssignmentCard", () => ({ default: () => null }));

const device = (id: number, hostname: string) =>
  ({
    id,
    hostname,
    platform: "windows",
    status: "online",
    freshness_state: "online",
    last_seen: new Date().toISOString(),
  }) as unknown as Device;

const lastCall = () => liveCalls[liveCalls.length - 1];

describe("DeviceDrawer live subscription", () => {
  beforeEach(() => {
    liveCalls.length = 0;
    appCache.invalidate();
  });

  it("starts when the drawer opens, holds on every tab, and stops on close", () => {
    const onClose = vi.fn();
    const { rerender } = render(<DeviceDrawer device={device(1, "HV-PROD-01")} isOpen={false} onClose={onClose} />);
    expect(lastCall()).toEqual([1, false]);

    rerender(<DeviceDrawer device={device(1, "HV-PROD-01")} isOpen onClose={onClose} />);
    expect(lastCall()).toEqual([1, true]);

    // Another tab keeps the stream: Overview has values when it comes back.
    fireEvent.click(screen.getByRole("tab", { name: "Monitoring" }));
    expect(lastCall()).toEqual([1, true]);
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(lastCall()).toEqual([1, true]);

    rerender(<DeviceDrawer device={device(1, "HV-PROD-01")} isOpen={false} onClose={onClose} />);
    expect(lastCall()).toEqual([1, false]);
  });

  it("moves to the device shown when the drawer switches devices", () => {
    const onClose = vi.fn();
    const { rerender } = render(<DeviceDrawer device={device(1, "HV-PROD-01")} isOpen onClose={onClose} />);
    expect(lastCall()).toEqual([1, true]);
    rerender(<DeviceDrawer device={device(2, "HV-PROD-02")} isOpen onClose={onClose} />);
    expect(lastCall()).toEqual([2, true]);
  });

  it("lays the Overview out in one order with one header style", () => {
    render(<DeviceDrawer device={device(1, "HV-PROD-01")} isOpen onClose={vi.fn()} />);
    const titles = Array.from(document.querySelectorAll(".th-tab-panel .th-section-head > .premium-kicker")).map(
      (h) => h.textContent,
    );
    // Last 24 hours, Client assignment and Components are mocked out here.
    expect(titles).toEqual(["Status", "Live", "Alerts", "Services", "Security", "Identity", "Network", "Maintenance"]);
  });
});
