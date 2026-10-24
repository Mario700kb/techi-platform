import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as configApi from "../../api/agentConfig";
import * as commandsApi from "../../api/agentCommands";
import * as clientsApi from "../../api/clients";
import AgentConfigPage from "../AgentConfig";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { role: "owner" }, can: () => true }) }));
vi.mock("../../contexts/AppDataContext", () => ({ useAppData: () => ({ fleetOverview: null }) }));
vi.mock("../../hooks/usePlatformFeatures", () => ({ usePlatformFeatures: () => ({ FEATURE_LINUX: true }) }));

const platforms = ["windows", "linux", "macos", "mikrotik", "synology", "qnap", "truenas", "vmware", "proxmox"];
const CONFIG: configApi.AgentConfig = {
  heartbeat_interval_seconds: 300,
  platform_heartbeat_intervals: Object.fromEntries(platforms.map((p) => [p, 300])),
  platform_inventory_intervals: Object.fromEntries(platforms.map((p) => [p, 1800])),
  online_threshold_minutes: 6,
  stale_threshold_minutes: 25,
  remote_support_managed_password_enabled: true,
  active_device_count: 905,
  projected_requests_per_second: 3.0,
  minimum_allowed_interval_seconds: 302,
  maximum_allowed_interval_seconds: 313,
  platform_minimum_intervals: Object.fromEntries(platforms.map((p) => [p, p === "windows" ? 280 : 60])),
};

describe("AgentConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks an interval that would make healthy devices stale, and says why", async () => {
    vi.spyOn(configApi, "getAgentConfig").mockResolvedValue(CONFIG);
    const put = vi.spyOn(configApi, "putAgentConfig");
    vi.spyOn(commandsApi, "getCommandHistory").mockResolvedValue([]);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    render(<AgentConfigPage />);

    const linux = await screen.findByRole("spinbutton", { name: "Linux heartbeat interval" });
    fireEvent.change(linux, { target: { value: "600" } });
    expect(screen.getByText(/Linux: heartbeat above 313s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save interval policy/ })).toBeDisabled();

    fireEvent.change(linux, { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: /Save interval policy/ }));
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ platform_heartbeat_intervals: expect.objectContaining({ linux: 240 }) }),
    );
  });

  it("does not offer the heartbeat-interval command, which every heartbeat would undo", async () => {
    vi.spyOn(configApi, "getAgentConfig").mockResolvedValue(CONFIG);
    vi.spyOn(commandsApi, "getCommandHistory").mockResolvedValue([]);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    render(<AgentConfigPage />);
    await screen.findByText("Send command");
    expect(
      screen.queryByRole("option", { name: commandsApi.BULK_COMMAND_LABELS.change_heartbeat_interval }),
    ).toBeNull();
  });

  it("turns one inventory part off for one platform and saves the whole table", async () => {
    vi.spyOn(configApi, "getAgentConfig").mockResolvedValue({
      ...CONFIG,
      platform_collect_software: { windows: true, linux: true, macos: true },
      platform_collect_services: { windows: true, linux: true, macos: true },
      platform_collect_processes: { windows: true, linux: true, macos: true },
    });
    const put = vi.spyOn(configApi, "putAgentConfig").mockResolvedValue(CONFIG);
    vi.spyOn(commandsApi, "getCommandHistory").mockResolvedValue([]);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    render(<AgentConfigPage />);

    const linuxProcesses = await screen.findByRole("switch", { name: "Collect processes on Linux" });
    expect(linuxProcesses).toHaveAttribute("aria-checked", "true");
    fireEvent.click(linuxProcesses);
    expect(linuxProcesses).toHaveAttribute("aria-checked", "false");
    const card = linuxProcesses.closest(".th-onb-card") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(put).toHaveBeenCalledWith({
      platform_collect_software: { windows: true, linux: true, macos: true },
      platform_collect_services: { windows: true, linux: true, macos: true },
      platform_collect_processes: { windows: true, linux: false, macos: true },
    });
  });
});
