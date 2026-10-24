import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteAction } from "../../api/actions";
import * as manageApi from "../../api/deviceManage";
import type { DeviceInventory } from "../../api/inventory";
import DeviceInventoryPanel from "../DeviceInventoryPanel";
import type { InventoryManage } from "../InventoryManage";

const inventory: DeviceInventory = {
  device_id: 983,
  reboot_required: false,
  patch_state: "up_to_date",
  software: [
    { name: "7-Zip 23.01", uninstall: "msi", uninstall_key: "HKLM\\...\\{7Z}" },
    { name: "Google Chrome" },
    { name: "TECHI Agent", uninstall: "msi", uninstall_key: "HKLM\\...\\{TA}" },
  ],
  services: [
    { name: "Spooler", display_name: "Print Spooler", status: "running" },
    { name: "wuauserv", display_name: "Windows Update", status: "stopped" },
    { name: "TechiAgent", display_name: "TECHI Agent", status: "running" },
  ],
  processes: [
    { pid: 9764, name: "chrome.exe", memory_mb: 207 },
    { pid: 700, name: "lsass.exe", memory_mb: 20 },
  ],
};

function action(id: number, status: RemoteAction["status"], extra: Partial<RemoteAction> = {}): RemoteAction {
  return {
    id,
    device_id: 983,
    action_type: "ping",
    status,
    created_at: "2026-10-24T19:00:00Z",
    execution_timeout_seconds: 60,
    ...extra,
  };
}

function manage(over: Partial<InventoryManage> = {}): InventoryManage {
  return {
    deviceId: 983,
    deviceName: "Mario-Lenovo",
    blockedReason: null,
    canOperate: true,
    canUninstall: true,
    actions: [],
    onQueued: vi.fn(),
    ...over,
  };
}

function renderPanel(m?: InventoryManage, onLoad = vi.fn()) {
  const view = render(
    <DeviceInventoryPanel inventory={inventory} loading={false} error={null} onLoad={onLoad} manage={m} />,
  );
  return { ...view, onLoad };
}

function showList(name: "Software" | "Services" | "Processes") {
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(name) }));
}

describe("DeviceInventoryPanel row actions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows no actions without manage (other platforms)", () => {
    renderPanel(undefined);
    expect(screen.queryByRole("button", { name: /Uninstall/ })).toBeNull();
  });

  it("explains why an app cannot be uninstalled", () => {
    renderPanel(manage({ canUninstall: false }));
    expect(screen.getByRole("button", { name: "Uninstall 7-Zip 23.01: Administrators only" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: /Uninstall Google Chrome: No silent uninstall/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Uninstall TECHI Agent: Part of TECHI/ })).toBeTruthy();
  });

  it("an older agent or an offline device makes every action unavailable, with the reason", () => {
    renderPanel(manage({ blockedReason: "Needs agent 2.1.41 or later; update the agent first" }));
    showList("Processes");
    const end = screen.getByRole("button", { name: /End chrome.exe: Needs agent 2.1.41/ });
    fireEvent.click(end);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ends a process after asking, then shows the agent's answer and reloads the list", async () => {
    const kill = vi.spyOn(manageApi, "killProcess").mockResolvedValue(action(41, "queued"));
    const m = manage();
    const { rerender, onLoad } = renderPanel(m);
    showList("Processes");
    expect(screen.getByRole("button", { name: /End lsass.exe: Protected/ })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", { name: "End chrome.exe" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("chrome.exe · PID 9764")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "End process" }));
    });
    expect(kill).toHaveBeenCalledWith(983, 9764, "chrome.exe");
    expect(m.onQueued).toHaveBeenCalled();
    expect(screen.getByText("Ending…")).toBeTruthy();

    rerender(
      <DeviceInventoryPanel
        inventory={inventory}
        loading={false}
        error={null}
        onLoad={onLoad}
        manage={{ ...m, actions: [action(41, "completed", { result_message: "Ended chrome.exe (PID 9764)" })] }}
      />,
    );
    expect(screen.getByText("Ended chrome.exe (PID 9764)")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(4_100));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("offers stop and restart for a running service, start for a stopped one, never stop for a protected one", () => {
    renderPanel(manage());
    showList("Services");
    expect(screen.getByRole("button", { name: "Restart Print Spooler" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Stop Print Spooler" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Start Windows Update" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop TECHI Agent: Protected/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("a failed service action keeps the agent's reason under the name", async () => {
    vi.spyOn(manageApi, "controlService").mockResolvedValue(action(42, "queued"));
    const m = manage();
    const { rerender, onLoad } = renderPanel(m);
    showList("Services");
    fireEvent.click(screen.getByRole("button", { name: "Stop Print Spooler" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }));
    });
    rerender(
      <DeviceInventoryPanel
        inventory={inventory}
        loading={false}
        error={null}
        onLoad={onLoad}
        manage={{
          ...m,
          actions: [
            action(42, "failed", { error_message: "other running services depend on Spooler; stop them first" }),
          ],
        }}
      />,
    );
    expect(screen.getByText(/other running services depend on Spooler/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Print Spooler" })).toBeTruthy();
  });

  it("an uninstall asks for a current two-factor code", async () => {
    const uninstall = vi.spyOn(manageApi, "uninstallSoftware").mockResolvedValue(action(43, "queued"));
    renderPanel(manage());
    fireEvent.click(screen.getByRole("button", { name: "Uninstall 7-Zip 23.01" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Uninstall" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Two-factor code"), { target: { value: "12 34 56" } });
    expect(confirm).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(uninstall).toHaveBeenCalledWith(983, "7-Zip 23.01", "HKLM\\...\\{7Z}", "123456");
    expect(screen.getByText("Uninstalling…")).toBeTruthy();
  });
});
