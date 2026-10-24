import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Device } from "../../api/devices";
import DevicesTable from "../DevicesTable";
import Toaster from "../Toaster";

vi.mock("../../hooks/usePlatformFeatures", () => ({
  usePlatformFeatures: () => ({ FEATURE_LINUX: false }),
}));
vi.mock("../../api/connect", () => ({
  CONNECT_REFRESH_EVENT: "connect-refresh",
  getConnectStatuses: vi.fn().mockResolvedValue({}),
}));

const preview = vi.fn();
const send = vi.fn();
vi.mock("../../api/agentCommands", async (importActual) => ({
  ...(await importActual<typeof import("../../api/agentCommands")>()),
  previewBulkSelfUpdate: (...a: unknown[]) => preview(...a),
  sendBulkCommand: (...a: unknown[]) => send(...a),
}));

const devices = [
  { id: 1, hostname: "Mario-Lenovo", freshness_state: "online", platform: "windows", agent_version: "2.1.32" },
  { id: 2, hostname: "HV-PROD-01", freshness_state: "online", platform: "windows", agent_version: "2.1.33" },
  { id: 3, hostname: "Reception", freshness_state: "offline", platform: "windows", agent_version: "2.1.20" },
] as Device[];

function renderTable(canUpdateAgents: boolean) {
  const onBulkComplete = vi.fn();
  render(
    <MemoryRouter>
      <Toaster />
      <DevicesTable
        {...({
          devices,
          loading: false,
          error: null,
          filters: {},
          searchQuery: "",
          onSearch: vi.fn(),
          onFilterChange: vi.fn(),
          onRefresh: vi.fn(),
          canOperate: true,
          canUpdateAgents,
          onBulkComplete,
        } as unknown as React.ComponentProps<typeof DevicesTable>)}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all devices on this page" }));
  return { onBulkComplete };
}

describe("DevicesTable · Update agent in the bulk bar", () => {
  beforeEach(() => {
    preview.mockReset().mockResolvedValue({
      version: "2.1.33",
      update: [
        { device_id: 1, name: "Mario-Lenovo", from_version: "2.1.32", to_version: "2.1.33", live: true },
        { device_id: 3, name: "Reception", from_version: "2.1.20", to_version: "2.1.33", live: false },
      ],
      skipped: [{ device_id: 2, name: "HV-PROD-01", reason: "Already on 2.1.33" }],
    });
    send.mockReset().mockResolvedValue({
      batch_id: "b1",
      device_count: 2,
      created_at: "2026-10-19T00:00:00Z",
      skipped: [],
      pushed: 1,
    });
  });

  it("is only offered to admins and owners", () => {
    renderTable(false);
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(bar).queryByRole("button", { name: "Update agent" })).not.toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Restart agent" })).toBeInTheDocument();
  });

  it("shows the plan, then updates only the devices that need it", async () => {
    const { onBulkComplete } = renderTable(true);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: "Update agent" }),
    );
    expect(screen.getByText("Checking the selected devices…")).toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveBeenCalledWith([1, 2, 3]));

    const plan = await screen.findByTestId("bulk-update-plan");
    expect(within(plan).getByLabelText("Devices to update")).toHaveTextContent("2.1.32 2.1.331 · Mario-Lenovo");
    expect(within(plan).getByLabelText("Devices to update")).toHaveTextContent("2.1.20 2.1.331 · Reception");
    expect(plan).toHaveTextContent("1 start at once over the live channel · 1 at their next heartbeat");
    expect(within(plan).getByLabelText("Devices left out")).toHaveTextContent("Already on 2.1.33 · HV-PROD-01");

    fireEvent.click(screen.getByRole("button", { name: "Update 2 devices" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        command_type: "self_update",
        target: "devices",
        device_ids: [1, 3],
        payload: {},
        timeout_seconds: 600,
      }),
    );
    expect(await screen.findByText("Agent update started on 2 devices · 1 at once · 1 left out")).toBeInTheDocument();
    expect(onBulkComplete).toHaveBeenCalled();
  });

  it("cannot be confirmed when nothing needs updating", async () => {
    preview.mockResolvedValue({
      version: "2.1.33",
      update: [],
      skipped: devices.map((d) => ({ device_id: d.id, name: d.hostname, reason: "Already on 2.1.33" })),
    });
    renderTable(true);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: "Update agent" }),
    );
    expect(await screen.findByText("Nothing to update in this selection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });
});
