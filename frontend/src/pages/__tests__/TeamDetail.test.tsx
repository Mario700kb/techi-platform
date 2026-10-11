import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as teamsApi from "../../api/teams";
import * as operatorsApi from "../../api/operators";
import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import TeamDetailPage from "../TeamDetail";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

const TEAM = {
  id: 3, name: "IT Support", description: null, color: "#F04A2A", created_at: "2026-06-04T08:00:00Z",
  operator_ids: [5], client_ids: [], group_ids: [10], device_ids: [], permissions: ["view_devices"], effective_device_count: 2,
} as unknown as teamsApi.TeamDetail;

function renderPage() {
  vi.spyOn(teamsApi, "getTeam").mockResolvedValue(TEAM);
  return render(
    <MemoryRouter initialEntries={["/teams/3"]}>
      <Routes><Route path="/teams/:id" element={<TeamDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("TeamDetail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("enables save only once membership changes, then saves the new set", async () => {
    vi.spyOn(operatorsApi, "getOperators").mockResolvedValue([
      { id: 5, username: "laura", display_name: "Laura", email: "l@techi.al", role: "operator", is_active: true } as operatorsApi.OperatorRecord,
      { id: 6, username: "sabina", display_name: "Sabina", email: "s@techi.al", role: "operator", is_active: true } as operatorsApi.OperatorRecord,
    ]);
    const save = vi.spyOn(teamsApi, "updateTeamMembers").mockResolvedValue(undefined as never);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Members/ }));
    const button = await screen.findByRole("button", { name: /Save members/ });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Member: Sabina" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save members (2)" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(3, [5, 6]));
  });

  it("loads every device for the access tree, past the 1,000-per-page cap", async () => {
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([{ id: 1, name: "Vasgroup" } as clientsApi.Client]);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue([{ id: 10, client_id: 1, name: "Servers" } as clientsApi.DeviceGroup]);
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, hostname: `pc-${from + i}`, client_id: 1, group_id: 10 }) as devicesApi.Device);
    const list = vi.spyOn(devicesApi, "getDevices")
      .mockResolvedValueOnce({ devices: page(1, 1000), total: 1002 })
      .mockResolvedValueOnce({ devices: page(1001, 2), total: 1002 });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Device access/ }));
    await screen.findByText("Vasgroup");
    expect(list).toHaveBeenNthCalledWith(2, {}, 1000, 1000);
    // Every device sits in the granted group, so all 1,002 are reached.
    const reached = screen.getByText("Devices reached").closest(".th-onb-stat")!;
    expect(within(reached as HTMLElement).getByText("1,002")).toBeInTheDocument();
  });

  it("applies a permission template with its dependencies", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Permissions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Deployment Operator" }));
    expect(screen.getByRole("checkbox", { name: "Deploy Packages" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "View Devices" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Deployment Operator" })).toHaveAttribute("aria-pressed", "true");
  });
});
