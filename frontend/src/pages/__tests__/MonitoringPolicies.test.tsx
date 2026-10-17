import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as clientsApi from "../../api/clients";
import * as monitoringApi from "../../api/monitoring";
import type { MonitoringPolicy, PipelineHealth } from "../../api/monitoring";
import { appCache } from "../../store/appCache";
import MonitoringPolicies from "../MonitoringPolicies";

const auth = vi.hoisted(() => ({ admin: true }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { role: auth.admin ? "admin" : "readonly" }, can: () => auth.admin }),
}));

const WORKSTATIONS: MonitoringPolicy = {
  id: 1,
  name: "Workstations",
  description: "Every device unless a more specific policy applies.",
  scope: "default",
  scope_value: null,
  enabled: true,
  version: 3,
  sample_seconds: 60,
  upload_seconds: 900,
  buffer_mb: 50,
  keep_days: 7,
  monitors: [
    { key: "cpu", metric: "cpu", op: ">", threshold: 95, duration_s: 900, severity: "critical", enabled: true },
    { key: "mem", metric: "mem", op: ">", threshold: 90, duration_s: 600, severity: "warning", enabled: true },
    { key: "disk", metric: "disk", op: ">", threshold: 90, duration_s: 0, severity: "warning", enabled: true },
    { key: "no_data", metric: "no_data", op: ">", threshold: 0, duration_s: 600, severity: "critical", enabled: true },
  ],
  updated_at: "2026-10-16T21:00:00Z",
  updated_by: "system",
  devices: 489,
  devices_current: 486,
};

const SERVERS: MonitoringPolicy = {
  ...WORKSTATIONS,
  id: 2,
  name: "Servers",
  description: "Every device classified as a server.",
  scope: "device_type",
  scope_value: "server",
  version: 5,
  monitors: [
    {
      key: "disk_forecast",
      metric: "disk_forecast_days",
      op: "<",
      threshold: 14,
      duration_s: 0,
      severity: "warning",
      enabled: true,
    },
    {
      key: "net_rx",
      metric: "net_rx_mbps",
      op: ">",
      threshold: 800,
      duration_s: 300,
      severity: "info",
      enabled: false,
    },
  ],
  devices: 38,
  devices_current: 38,
};

const PIPELINE: PipelineHealth = {
  devices_online: 516,
  devices_one_minute: 512,
  uploads_last_hour: 509,
  median_delay_seconds: 420,
  devices_with_backlog: 4,
  oldest_backlog_at: null,
  dropped_30d: 0,
  samples_30d: 600_000,
  policy_behind: 3,
  storage: [
    { name: "1-minute", keep: "7 days", bytes: 600 * 1024 ** 2, rows: null },
    { name: "5-minute", keep: "30 days", bytes: 800 * 1024 ** 2, rows: null },
    { name: "Hourly", keep: "13 months", bytes: 1024 ** 3, rows: null },
  ],
};

function setup() {
  vi.spyOn(monitoringApi, "listMonitoringPolicies").mockResolvedValue([SERVERS, WORKSTATIONS]);
  const pipeline = vi.spyOn(monitoringApi, "getPipelineHealth").mockResolvedValue(PIPELINE);
  vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
  vi.spyOn(clientsApi, "getGroups").mockResolvedValue([]);
  const update = vi
    .spyOn(monitoringApi, "updateMonitoringPolicy")
    .mockImplementation(async (id, body) => ({ ...(id === 1 ? WORKSTATIONS : SERVERS), ...body, version: 4 }));
  const remove = vi.spyOn(monitoringApi, "deleteMonitoringPolicy").mockResolvedValue(undefined);
  render(<MonitoringPolicies />);
  return { pipeline, update, remove };
}

const editor = (name: string) => screen.findByRole("region", { name: `Policy ${name}` });

describe("MonitoringPolicies", () => {
  beforeEach(() => {
    auth.admin = true;
    appCache.invalidate();
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists the policies broad to specific, with their scope and sync in words", async () => {
    setup();
    const list = await screen.findByRole("region", { name: "Policies" });
    const items = await within(list).findAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining("Workstations"),
      expect.stringContaining("Servers"),
    ]);
    expect(items[0]).toHaveTextContent("Default · every device");
    expect(items[0]).toHaveTextContent("4 monitors");
    expect(items[0]).toHaveTextContent("486 / 489 on v3");
    expect(items[1]).toHaveTextContent("Every server");
    expect(items[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/A device follows its most specific policy/)).toBeInTheDocument();
  });

  it("publishes an edited threshold with the whole policy body", async () => {
    const { update } = setup();
    const card = await editor("Workstations");
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Monitor 1 threshold" }), {
      target: { value: "92" },
    });
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Upload every" }), { target: { value: "5" } });
    fireEvent.click(within(card).getByRole("button", { name: "Publish v4 to 489 devices" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(1, {
      name: "Workstations",
      description: "Every device unless a more specific policy applies.",
      scope: "default",
      scope_value: null,
      enabled: true,
      sample_seconds: 60,
      upload_seconds: 300,
      buffer_mb: 50,
      keep_days: 7,
      monitors: [
        { key: "cpu", metric: "cpu", op: ">", threshold: 92, duration_s: 900, severity: "critical", enabled: true },
        { key: "mem", metric: "mem", op: ">", threshold: 90, duration_s: 600, severity: "warning", enabled: true },
        { key: "disk", metric: "disk", op: ">", threshold: 90, duration_s: 0, severity: "warning", enabled: true },
        {
          key: "no_data",
          metric: "no_data",
          op: ">",
          threshold: 0,
          duration_s: 600,
          severity: "critical",
          enabled: true,
        },
      ],
    });
    expect(await within(card).findByText("Published v4 to 489 devices")).toBeInTheDocument();
  });

  it("blocks values outside the backend's limits and says which", async () => {
    const { update } = setup();
    const card = await editor("Workstations");
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Sample every" }), { target: { value: "10" } });
    expect(within(card).getByText("Sample every 30–900 seconds.")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Publish v4/ })).toBeDisabled();

    fireEvent.change(within(card).getByRole("spinbutton", { name: "Sample every" }), { target: { value: "60" } });
    fireEvent.change(within(card).getByRole("textbox", { name: "Monitor 2 key" }), { target: { value: "cpu" } });
    expect(within(card).getByText("Monitor 2: each monitor needs its own key.")).toBeInTheDocument();

    fireEvent.change(within(card).getByRole("textbox", { name: "Monitor 2 key" }), { target: { value: "mem" } });
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Monitor 1 threshold" }), {
      target: { value: "120" },
    });
    expect(within(card).getByText("Monitor 1: a threshold between 1 and 100%.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("shows the server's message when a publish is refused", async () => {
    const { update } = setup();
    update.mockRejectedValueOnce(new Error("Each monitor needs its own key"));
    const card = await editor("Workstations");
    fireEvent.click(within(card).getByRole("switch", { name: "Monitor 2 on" }));
    fireEvent.click(within(card).getByRole("button", { name: /Publish v4/ }));
    expect(await within(card).findByText("Each monitor needs its own key")).toBeInTheDocument();
  });

  it("adds a monitor whose key overrides the broader policy's", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Servers/ }));
    const card = await editor("Servers");
    fireEvent.click(within(card).getByRole("button", { name: "Add monitor" }));
    expect(within(card).getByRole("textbox", { name: "Monitor 3 key" })).toHaveValue("cpu");
    expect(within(card).getByText("Replaces Workstations")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Remove monitor 3" }));
    expect(within(card).queryByRole("textbox", { name: "Monitor 3 key" })).toBeNull();
  });

  it("asks before dropping unpublished edits when switching policy", async () => {
    setup();
    const card = await editor("Workstations");
    fireEvent.change(within(card).getByRole("textbox", { name: "Name" }), { target: { value: "Desktops" } });
    fireEvent.click(screen.getByRole("button", { name: /Servers/ }));
    const dialog = await screen.findByRole("dialog", { name: "Discard unpublished changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(card).getByRole("textbox", { name: "Name" })).toHaveValue("Desktops");

    fireEvent.click(screen.getByRole("button", { name: /Servers/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }));
    expect(await editor("Servers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Workstations/ }));
    expect(within(await editor("Workstations")).getByRole("textbox", { name: "Name" })).toHaveValue("Workstations");
  });

  it("deletes a non-default policy after confirmation; the default has no delete", async () => {
    const { remove } = setup();
    const card = await editor("Workstations");
    expect(within(card).queryByRole("button", { name: /Delete policy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Servers/ }));
    fireEvent.click(within(await editor("Servers")).getByRole("button", { name: "Delete policy Servers" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Servers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete policy" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(2));
    expect(await editor("Workstations")).toBeInTheDocument();
  });

  it("shows pipeline health and storage to admins", async () => {
    setup();
    const pipeline = await screen.findByRole("region", { name: "Pipeline health" });
    expect(await within(pipeline).findByText("512 / 516")).toBeInTheDocument();
    expect(within(pipeline).getByText("7 min")).toBeInTheDocument();
    expect(within(pipeline).getByText("0%")).toBeInTheDocument();
    expect(within(pipeline).getByText("Healthy")).toBeInTheDocument();
    const storage = screen.getByRole("region", { name: "Storage" });
    expect(within(storage).getByText("2.4 GB in total")).toBeInTheDocument();
    expect(within(storage).getByText("13 months · 1.0 GB")).toBeInTheDocument();
  });

  it("is read-only for a non-admin, without pipeline health", async () => {
    auth.admin = false;
    const { pipeline } = setup();
    const card = await editor("Workstations");
    expect(within(card).getByText("CPU usage")).toBeInTheDocument();
    expect(within(card).getByText("> 95%")).toBeInTheDocument();
    expect(within(card).queryByRole("spinbutton", { name: "Monitor 1 threshold" })).toBeNull();
    expect(within(card).getByRole("spinbutton", { name: "Sample every" })).toBeDisabled();
    expect(within(card).queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(within(card).getByText("You can view this policy; changing it needs an admin.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New policy" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pipeline health" })).toBeNull();
    expect(pipeline).not.toHaveBeenCalled();
  });
});
