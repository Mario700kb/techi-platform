import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as actionsApi from "../../api/actions";
import * as alertsApi from "../../api/alerts";
import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import * as operatorsApi from "../../api/operators";
import { appCache } from "../../store/appCache";
import Dashboard from "../Dashboard";

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role: "operator", username: "op" }, hasPermission: () => false }),
}));

vi.mock("../../contexts/AppDataContext", () => ({
  useAppData: () => ({
    fleetOverview: {
      stats: { total: 900, online: 800, stale: 20, offline: 80 },
      tree_counts: { by_client: { "1": 42, "2": 858 }, unassigned: 0 },
      active_agent_version: "2.1.47",
    },
    fleetOverviewLoading: false,
    latestEvent: null,
    realtimeStatus: "connected",
    refreshFleetOverview: vi.fn(),
    alertCountReady: true,
    alertCount: { total_open: 50, by_severity: { warning: 50 } },
    totalOpenAlerts: 50,
  }),
}));

const never = <T,>() => new Promise<T>(() => undefined);

const PROFILE = {
  client: { id: 1, name: "Northwind Clinic", slug: "northwind", description: null, is_active: true, created_at: "" },
  stats: { total: 42, online: 28, stale: 3, offline: 11 },
  by_category: { clientpc: { total: 42, online: 28, stale: 3, offline: 11 } },
  alerts: { total_open: 14, by_severity: { critical: 2, warning: 12 }, by_kind: { low_disk: 14 }, devices_affected: 9 },
  average_health: 77,
  health_critical: 3,
  health_warning: 5,
  needs_updates: 6,
  agents_outdated: 4,
  groups: [
    { id: 5, name: "Reception", devices: 30 },
    { id: 6, name: "Doctors", devices: 12 },
  ],
  last_seen: null,
} as unknown as clientsApi.ClientProfile;

describe("Dashboard for one client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([
      { id: 1, name: "Northwind Clinic" },
      { id: 2, name: "Blue Harbor" },
    ] as clientsApi.Client[]);
    vi.spyOn(clientsApi, "getClientProfile").mockResolvedValue(PROFILE);
    vi.spyOn(devicesApi, "getFleetInsights").mockImplementation(never);
    vi.spyOn(devicesApi, "getFleetRisk").mockImplementation(never);
    vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [], total: 0 });
    vi.spyOn(actionsApi, "getRecentActions").mockResolvedValue([]);
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue([]);
    vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [], total: 0 });
  });

  it("reads every card from the client's profile and asks the lists for that client", async () => {
    render(
      <MemoryRouter initialEntries={["/?client=1"]}>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(
      await screen.findAllByText(
        "Northwind Clinic: health, open issues and recent activity. Operators and system status are platform-wide.",
      ),
    ).not.toHaveLength(0);
    await waitFor(() => expect(screen.getAllByText("42").length).toBeGreaterThan(0));
    expect(screen.queryByText("900")).not.toBeInTheDocument();

    const alerts = screen.getByText("Open alerts by type").closest("section")!;
    expect(within(alerts).getByText("14 open on 9 devices.")).toBeInTheDocument();

    const groups = screen.getByText("Devices by group").closest("section")!;
    expect(within(groups).getByText("Reception")).toBeInTheDocument();
    expect(within(groups).getByText("Reception").closest("a")).toHaveAttribute("href", "/devices?folder=client-1");

    expect(devicesApi.getDevices).toHaveBeenCalledWith({ client_id: 1 }, 0, 50);
    expect(actionsApi.getRecentActions).toHaveBeenCalledWith(50, 1);
    expect(devicesApi.getFleetInsights).toHaveBeenCalledWith(30, 1);
    expect(devicesApi.getFleetRisk).toHaveBeenCalledWith(1);
    expect(alertsApi.getAlertQueue).toHaveBeenCalledWith({ view: "overdue", clientId: 1, limit: 1 });
  });

  it("shows the whole fleet without a client in the address", async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText("900").length).toBeGreaterThan(0));
    expect(screen.getByText("Devices by client")).toBeInTheDocument();
    expect(clientsApi.getClientProfile).not.toHaveBeenCalled();
    expect(devicesApi.getFleetRisk).toHaveBeenCalledWith(undefined);
  });
});
