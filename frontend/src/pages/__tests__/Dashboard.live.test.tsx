import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as actionsApi from "../../api/actions";
import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import type { Device } from "../../api/devices";
import * as operatorsApi from "../../api/operators";
import type { OperatorPresenceRecord } from "../../api/operators";
import type { DeviceRealtimeEvent } from "../../services/deviceRealtime";
import { appCache } from "../../store/appCache";
import Dashboard from "../Dashboard";

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role: "operator", username: "op" }, hasPermission: () => false }),
}));

const appData = {
  fleetOverview: {
    stats: { total: 3, online: 2, stale: 0, offline: 1 },
    tree_counts: { by_client: {}, unassigned: 0 },
  },
  fleetOverviewLoading: false,
  lastFetchTime: Date.now(),
  latestEvent: null as DeviceRealtimeEvent | null,
  realtimeStatus: "connected",
  refreshFleetOverview: vi.fn(),
  totalOpenAlerts: 0,
};
vi.mock("../../contexts/AppDataContext", () => ({ useAppData: () => appData }));

const device = (id: number, hostname: string) =>
  ({ id, hostname, display_name: null, freshness_state: "online", status: "online" }) as unknown as Device;
const operator = (id: number, username: string, isOnline: boolean) =>
  ({ id, username, display_name: username, is_online: isOnline }) as unknown as OperatorPresenceRecord;

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard stays current while open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.restoreAllMocks();
    appCache.invalidate();
    appData.latestEvent = null;
    appData.realtimeStatus = "connected";
    appData.lastFetchTime = Date.now();
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(devicesApi, "getFleetInsights").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(actionsApi, "getRecentActions").mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads operator presence every minute with the socket connected", async () => {
    vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [], total: 0 });
    const presence = vi
      .spyOn(operatorsApi, "getOperatorPresence")
      .mockResolvedValueOnce([operator(1, "ana", true)])
      .mockResolvedValue([operator(1, "ana", true), operator(2, "ben", true)]);

    renderDashboard();
    expect(await screen.findByText(/1 operator\s+online/)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(61_000));
    await waitFor(() => expect(presence).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/2 operators\s+online/)).toBeInTheDocument();
  });

  it("reloads Latest enrollments when a newly enrolled device reports in", async () => {
    const getDevices = vi
      .spyOn(devicesApi, "getDevices")
      .mockResolvedValueOnce({ devices: [device(11, "PC-ELEVEN"), device(10, "PC-TEN")], total: 2 })
      .mockResolvedValue({ devices: [device(12, "PC-NEW"), device(11, "PC-ELEVEN")], total: 3 });
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue([]);

    const view = renderDashboard();
    expect(await screen.findByText("PC-ELEVEN")).toBeInTheDocument();

    // An older device outside the list: nothing to do.
    appData.latestEvent = { type: "heartbeat_received", data: { id: 3 } } as unknown as DeviceRealtimeEvent;
    view.rerender(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(getDevices).toHaveBeenCalledTimes(1);

    // A device newer than every row has just enrolled.
    appData.latestEvent = { type: "heartbeat_received", data: { id: 12 } } as unknown as DeviceRealtimeEvent;
    view.rerender(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(await screen.findByText("PC-NEW")).toBeInTheDocument();
    expect(getDevices).toHaveBeenCalledTimes(2);
  });

  it("says when the fleet counts were last updated", async () => {
    vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [], total: 0 });
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue([]);
    appData.lastFetchTime = Date.now() - 3 * 60_000;

    renderDashboard();
    expect(await screen.findByText("· updated 3m ago")).toBeInTheDocument();
  });
});
