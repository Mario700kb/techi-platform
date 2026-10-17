import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GenericDeviceDrawer from "../GenericDeviceDrawer";
import type { Device } from "../../api/devices";
import type { DrawerMeta } from "../../api/platform";
import { appCache } from "../../store/appCache";

const getMeta = vi.fn();
const getInventory = vi.fn();

vi.mock("../../api/platform", () => ({ getDrawerMeta: (...a: unknown[]) => getMeta(...a) }));
vi.mock("../../api/inventory", () => ({ getDeviceInventory: (...a: unknown[]) => getInventory(...a) }));
vi.mock("../../api/notes", () => ({ getDeviceNotes: vi.fn().mockResolvedValue([]), createDeviceNote: vi.fn() }));
vi.mock("../../api/actions", () => ({ queueDeviceAction: vi.fn() }));
vi.mock("../../api/devices", () => ({
  assignDeviceClient: vi.fn(),
  assignDeviceGroup: vi.fn(),
  updateDevice: vi.fn(),
}));
vi.mock("../../hooks/useDeviceActivity", () => ({
  useDeviceActivity: () => ({ events: [], loading: false, reload: vi.fn() }),
}));
vi.mock("../../hooks/useDeviceTelemetry", () => ({
  useDeviceTelemetry: () => ({
    snapshot: {
      cpu_percent: 12,
      ram_percent: 40,
      disk_percent: 88,
      uptime_seconds: 3600,
      created_at: "2026-10-17T10:00:00Z",
    },
    healthScore: 90,
    healthState: "healthy",
  }),
}));
vi.mock("../../api/monitoring", async (importActual) => ({
  ...(await importActual<typeof import("../../api/monitoring")>()),
  getDeviceMetrics: vi.fn().mockRejectedValue(new Error("not here")),
  getDeviceMonitoring: vi.fn().mockRejectedValue(new Error("not here")),
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
    appCache.invalidate();
    getMeta.mockReset().mockResolvedValue(META);
    getInventory.mockReset();
  });

  it("uses accessible tabs, the freshness chip and one place for current values", async () => {
    getInventory.mockResolvedValue({ services: [], processes: [], software: [] });
    renderDrawer();
    const overview = await screen.findByRole("tab", { name: "Overview" });
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Stale")).toBeInTheDocument();
    // Current values come from the last heartbeat, labelled as such, once.
    const now = screen.getByRole("region", { name: "Live" });
    expect(within(now).getByText(/From the last heartbeat/)).toBeInTheDocument();
    expect(within(now).getByText("40%")).toBeInTheDocument();
    expect(within(now).getByText("88% used")).toBeInTheDocument();
    // History has its own section and no duplicate current bars.
    expect(screen.getByRole("region", { name: "Last 24 hours" })).toBeInTheDocument();
    // Linux agents send the metrics pipeline: Monitoring sits after Overview,
    // and actions live under Maintenance.
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.slice(0, 2)).toEqual(["Overview", "Monitoring"]);
    expect(tabs).toContain("Maintenance");
    expect(screen.queryByText("Resources")).toBeNull();
    expect(document.querySelector(".th-drawer.th-drawer-panel")).not.toBeNull();
  });

  it("shows a retryable error when the inventory fails, and a row count when truncated", async () => {
    getInventory.mockRejectedValueOnce(new Error("boom"));
    renderDrawer();
    fireEvent.click(await screen.findByRole("tab", { name: "Services" }));
    expect(await screen.findByText("Couldn't load services")).toBeInTheDocument();

    const services = Array.from({ length: 250 }, (_, i) => ({
      name: `svc${i}`,
      display_name: `Service ${i}`,
      status: "running",
    }));
    getInventory.mockResolvedValueOnce({ services, processes: [], software: [] });
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Showing 200 of 250")).toBeInTheDocument();
  });

  it("explains capabilities without a detailed view in plain words", async () => {
    getInventory.mockResolvedValue({ services: [], processes: [], software: [] });
    renderDrawer();
    fireEvent.click(await screen.findByRole("tab", { name: "Docker" }));
    await waitFor(() =>
      expect(screen.getByText("Detailed view not available yet for this platform")).toBeInTheDocument(),
    );
  });
});
