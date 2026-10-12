import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as actionsApi from "../../api/actions";
import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import * as operatorsApi from "../../api/operators";
import { AlertFlowChart } from "../../components/InsightCharts";
import { appCache } from "../../store/appCache";
import Dashboard from "../Dashboard";
import { actionRelevantTime, DashboardMobile } from "../DashboardMobile";

const auth = vi.hoisted(() => ({ canManage: false }));

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 1, role: "operator", username: "op" },
    hasPermission: (perm: string) => perm === "manage_operators" && auth.canManage,
  }),
}));

vi.mock("../../contexts/AppDataContext", () => ({
  useAppData: () => ({
    fleetOverview: {
      stats: { total: 1234, online: 1200, stale: 4, offline: 30 },
      needs_updates: 2500,
      tree_counts: { by_client: {}, unassigned: 0 },
    },
    fleetOverviewLoading: false,
    latestEvent: null,
    realtimeStatus: "connected",
    refreshFleetOverview: vi.fn(),
    totalOpenAlerts: 0,
  }),
}));

const never = <T,>() => new Promise<T>(() => undefined);

const operators = Array.from({ length: 8 }, (_, i) => ({
  id: i + 10,
  username: `op${i}`,
  display_name: `Operator ${i}`,
  role: "operator",
  is_online: i === 7,
})) as unknown as operatorsApi.OperatorPresenceRecord[];

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard consistency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
    auth.canManage = false;
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(devicesApi, "getFleetInsights").mockImplementation(never);
    vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [], total: 0 });
    vi.spyOn(actionsApi, "getRecentActions").mockResolvedValue([]);
    vi.spyOn(operatorsApi, "getOperatorPresence").mockResolvedValue(operators);
  });

  it("groups thousands in KPI values and uses one label for the updates filter", async () => {
    renderDashboard();
    expect(screen.getAllByText("1,234").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2,500").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs updates").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Pending updates")).not.toBeInTheDocument();
  });

  it("caps the operators list at six, online first, without a link for users who cannot manage operators", async () => {
    renderDashboard();
    const panel = (await screen.findByText("Operators")).closest("section")!;
    await within(panel).findByText("Operator 7");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(6);
    expect(within(panel).queryByText("View all")).not.toBeInTheDocument();
    const chip = screen.getByText(/1 operator online/);
    expect(chip.closest("a")).toBeNull();
  });

  it("links to the operators page when the user can manage operators", async () => {
    auth.canManage = true;
    renderDashboard();
    expect(await screen.findByRole("link", { name: "View all" })).toHaveAttribute("href", "/operators");
    expect(screen.getByText(/1 operator online/).closest("a")).toHaveAttribute("href", "/operators");
  });
});

describe("DashboardMobile", () => {
  it("names the online share in English and matches the desktop labels", () => {
    render(
      <MemoryRouter>
        <DashboardMobile
          total={2000}
          online={1500}
          stale={0}
          offline={0}
          criticalCount={0}
          patchCount={3}
          alertsTotal={2}
          agentsOutdated={1}
          actionsLoading={false}
          loading={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "75% online — 1,500 of 2,000" })).toBeInTheDocument();
    for (const label of ["Needs updates", "Open alerts", "Agent updates", "Recent remote actions"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows the finishing time of an action, not its creation time", () => {
    const action = {
      created_at: "2026-10-10T10:00:00Z",
      started_at: "2026-10-10T10:01:00Z",
      completed_at: "2026-10-10T10:05:00Z",
    } as actionsApi.RemoteAction;
    expect(actionRelevantTime(action)).toBe("2026-10-10T10:05:00Z");
  });
});

describe("AlertFlowChart", () => {
  it("says so when the week had no alerts instead of drawing an empty grid", () => {
    render(<AlertFlowChart series={[{ date: "2026-10-05", opened: 0, resolved: 0 }]} />);
    expect(screen.getByText("No alerts opened or resolved this week.")).toBeInTheDocument();
  });

  it("handles an empty series", () => {
    render(<AlertFlowChart series={[]} />);
    expect(screen.getByText("No alerts opened or resolved this week.")).toBeInTheDocument();
  });
});
