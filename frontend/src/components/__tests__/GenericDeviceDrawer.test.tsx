import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GenericDeviceDrawer from "../GenericDeviceDrawer";
import type { Device } from "../../api/devices";
import type { DrawerMeta } from "../../api/platform";

const getMeta = vi.fn();
const getInventory = vi.fn();

vi.mock("../../api/platform", () => ({ getDrawerMeta: (...a: unknown[]) => getMeta(...a) }));
vi.mock("../../api/inventory", () => ({ getDeviceInventory: (...a: unknown[]) => getInventory(...a) }));
vi.mock("../../api/notes", () => ({ getDeviceNotes: vi.fn().mockResolvedValue([]), createDeviceNote: vi.fn() }));
vi.mock("../../api/actions", () => ({ queueDeviceAction: vi.fn() }));
vi.mock("../../api/devices", () => ({ assignDeviceClient: vi.fn(), assignDeviceGroup: vi.fn(), updateDevice: vi.fn() }));
vi.mock("../../hooks/useDeviceActivity", () => ({ useDeviceActivity: () => ({ events: [], loading: false, reload: vi.fn() }) }));
vi.mock("../../hooks/useDeviceTelemetry", () => ({
  useDeviceTelemetry: () => ({ snapshot: { cpu_percent: 12, ram_percent: 40, disk_percent: 88 }, healthScore: 90, healthState: "healthy" }),
}));
vi.mock("../../hooks/usePlatformFeatures", () => ({ usePlatformFeatures: () => ({ FEATURE_TERMINAL: false }) }));
vi.mock("../ComponentStatesPanel", () => ({ default: () => null }));
vi.mock("../ConnectMenu", () => ({ default: () => null }));

const META: DrawerMeta = {
  platform: "linux",
  capabilities: [],
  remote_support: false,
  terminal: false,
  capability_tabs: ["services", "docker"],
  connect_methods: [],
  actions: [{ id: "reboot", label: "Reboot", confirm: "confirm", target: "agent" }],
};

const DEVICE = {
  id: 7,
  hostname: "web-01",
  display_name: "Web server",
  platform: "linux",
  status: "online",
  freshness_state: "stale",
  last_seen: "2026-10-05T14:44:00",
} as unknown as Device;

function renderDrawer() {
  return render(<GenericDeviceDrawer device={DEVICE} isOpen onClose={vi.fn()} />);
}

describe("GenericDeviceDrawer", () => {
  beforeEach(() => {
    getMeta.mockReset().mockResolvedValue(META);
    getInventory.mockReset();
  });

  it("uses accessible tabs, the freshness chip and shared resource bars", async () => {
    getInventory.mockResolvedValue({ services: [], processes: [], software: [] });
    renderDrawer();
    const overview = await screen.findByRole("tab", { name: "Overview" });
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Disk")).toBeInTheDocument();
    expect(document.querySelector(".th-drawer.th-drawer-panel")).not.toBeNull();
  });

  it("shows a retryable error when the inventory fails, and a row count when truncated", async () => {
    getInventory.mockRejectedValueOnce(new Error("boom"));
    renderDrawer();
    fireEvent.click(await screen.findByRole("tab", { name: "Services" }));
    expect(await screen.findByText("Couldn't load services")).toBeInTheDocument();

    const services = Array.from({ length: 250 }, (_, i) => ({ name: `svc${i}`, display_name: `Service ${i}`, status: "running" }));
    getInventory.mockResolvedValueOnce({ services, processes: [], software: [] });
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Showing 200 of 250")).toBeInTheDocument();
  });

  it("explains capabilities without a detailed view in plain words", async () => {
    getInventory.mockResolvedValue({ services: [], processes: [], software: [] });
    renderDrawer();
    fireEvent.click(await screen.findByRole("tab", { name: "Docker" }));
    await waitFor(() => expect(screen.getByText("Detailed view not available yet for this platform")).toBeInTheDocument());
  });
});
