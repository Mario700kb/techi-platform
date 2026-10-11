import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as actionsApi from "../../api/actions";
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
    fleetOverview: { stats: { total: 3, online: 2, stale: 0, offline: 1 }, tree_counts: { by_client: {}, unassigned: 0 } },
    fleetOverviewLoading: false,
    latestEvent: null,
    realtimeStatus: "connected",
    refreshFleetOverview: vi.fn(),
    totalOpenAlerts: 0,
  }),
}));

const never = <T,>() => new Promise<T>(() => undefined);

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard activity cards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(devicesApi, "getFleetInsights").mockImplementation(never);
  });

  it("loads the lists on arrival even when the live socket is already connected", async () => {
    const getDevices = vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [], total: 0 });
    vi.spyOn(actionsApi, "getRecentActions").mockResolvedValue([]);
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue([]);

    renderDashboard();

    await waitFor(() => expect(getDevices).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("No devices yet")).toBeInTheDocument();
  });

  it("shows loading, not an empty fleet, while the lists are still on their way", async () => {
    vi.spyOn(devicesApi, "getDevices").mockImplementation(never);
    vi.spyOn(actionsApi, "getRecentActions").mockImplementation(never);
    vi.spyOn(operatorsApi, "getOperatorPresence").mockImplementation(never);

    renderDashboard();

    expect(await screen.findByText("Loading devices…")).toBeInTheDocument();
    expect(screen.getByText("Loading actions…")).toBeInTheDocument();
    expect(screen.queryByText("No devices yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No remote actions yet")).not.toBeInTheDocument();
  });

  it("says a list failed to load instead of showing it as empty, and retries", async () => {
    const getDevices = vi.spyOn(devicesApi, "getDevices").mockRejectedValue(new Error("502"));
    vi.spyOn(actionsApi, "getRecentActions").mockResolvedValue([]);
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue([]);

    renderDashboard();

    expect(await screen.findByText("Couldn't load devices")).toBeInTheDocument();
    expect(screen.queryByText("No devices yet")).not.toBeInTheDocument();
    expect(screen.getByText("No remote actions yet")).toBeInTheDocument();

    getDevices.mockResolvedValue({ devices: [], total: 0 });
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() => expect(screen.getByText("No devices yet")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load devices")).not.toBeInTheDocument();
  });
});
