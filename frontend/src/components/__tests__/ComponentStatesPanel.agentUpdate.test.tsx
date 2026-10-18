import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ComponentStatesPanel from "../ComponentStatesPanel";
import type { RemoteAction } from "../../api/actions";
import type { DeviceComponentStatesResponse, PlatformComponentsResponse } from "../../api/platform";
import type { DeviceRealtimeEvent, DeviceRealtimeStatus } from "../../services/deviceRealtime";

const getStates = vi.fn();
const getComponents = vi.fn();
const queueAction = vi.fn();
const retryAction = vi.fn();
const cancelAction = vi.fn();
const getDeviceActions = vi.fn();

vi.mock("../../api/platform", () => ({
  getDeviceComponentStates: (...a: unknown[]) => getStates(...a),
  getPlatformComponents: (...a: unknown[]) => getComponents(...a),
  queueComponentAction: (...a: unknown[]) => queueAction(...a),
  retryComponentAction: (...a: unknown[]) => retryAction(...a),
}));
vi.mock("../../api/actions", () => ({
  cancelAction: (...a: unknown[]) => cancelAction(...a),
  getDeviceActions: (...a: unknown[]) => getDeviceActions(...a),
}));

// The panel's realtime socket, driven by the test.
let emit: (event: DeviceRealtimeEvent) => void = () => {};
let socketStatus: DeviceRealtimeStatus = "connected";
vi.mock("../../hooks/useDeviceRealtime", () => ({
  useDeviceRealtime: ({ onEvent }: { onEvent: (event: DeviceRealtimeEvent) => void }) => {
    emit = onEvent;
    return socketStatus;
  },
}));

function states(installed: string): DeviceComponentStatesResponse {
  const current = installed === "2.1.31";
  return {
    schema_version: 1,
    device_id: 7,
    components: [
      {
        component_id: "agent",
        display_name: "TECHI Agent",
        icon_key: "agent",
        installed_version: installed,
        desired_version: "2.1.31",
        health: current ? "current" : "outdated",
        status: current ? "Current" : "Outdated",
      },
    ],
  };
}

const COMPONENTS: PlatformComponentsResponse = {
  schema_version: 1,
  components: [
    {
      id: "agent",
      display_name: "TECHI Agent",
      description: "",
      icon_key: "agent",
      platforms: ["windows"],
      file_types: ["agent_binary"],
      capabilities: [],
      lifecycle: [
        { operation: "update", label: "Update", action_type: "self_update", kind: "action" },
        { operation: "restart", label: "Restart", action_type: "restart_agent", kind: "action" },
      ],
      policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
    },
  ],
};

function update(overrides: Partial<RemoteAction> = {}): RemoteAction {
  return {
    id: 50,
    device_id: 7,
    action_type: "self_update" as RemoteAction["action_type"],
    status: "queued",
    created_at: new Date().toISOString(),
    execution_timeout_seconds: 600,
    parameters: { version: "2.1.31", download_url: "https://x/agent.exe" },
    progress: null,
    stage: null,
    ...overrides,
  };
}

function send(action: RemoteAction, type: "action_queued" | "action_status_changed" = "action_status_changed") {
  act(() => emit({ type, data: action as unknown as DeviceRealtimeEvent["data"] }));
}

const bar = () => screen.getByTestId("agent-update-live").querySelector('[role="progressbar"]') as HTMLElement;

describe("ComponentStatesPanel — live agent update", () => {
  beforeEach(() => {
    socketStatus = "connected";
    getStates.mockResolvedValue(states("2.1.30"));
    getComponents.mockResolvedValue(COMPONENTS);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("replaces the buttons with the stage, and the bar turns determinate once a % arrives", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });

    send(update(), "action_queued");
    expect(screen.getByText("Queued — goes out at once over the live channel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Update/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(bar()).toHaveAttribute("data-indeterminate", "true");
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    expect(within(screen.getByTestId("agent-update-live")).getByText("2.1.31")).toBeInTheDocument();
    expect(within(screen.getByTestId("agent-update-live")).getByText("2.1.30")).toBeInTheDocument();

    send(update({ status: "sent" }));
    expect(screen.getByText("Sent to the agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    send(update({ status: "running", stage: "downloading", progress: 42, result_message: "(2.6 of 6.3 MB)" }));
    expect(screen.getByText(/Downloading 42%/)).toBeInTheDocument();
    expect(screen.getByText(/2\.6 of 6\.3 MB/)).toBeInTheDocument();
    expect(bar()).not.toHaveAttribute("data-indeterminate");
    expect(bar()).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();

    // A late copy of an earlier event never drags it back.
    send(update({ status: "running", stage: "downloading", progress: 20 }));
    expect(bar()).toHaveAttribute("aria-valuenow", "42");

    send(update({ status: "running", stage: "verifying", progress: 85 }));
    expect(screen.getByText("Verifying the package")).toBeInTheDocument();
    send(update({ status: "running", stage: "installing", progress: 90 }));
    expect(screen.getByText("Installing")).toBeInTheDocument();
    send(update({ status: "running", stage: "restarting", progress: 95 }));
    expect(screen.getByText("Restarting the agent")).toBeInTheDocument();
    send(update({ status: "running", stage: "confirming", progress: 97 }));
    expect(screen.getByText("Confirming the new version")).toBeInTheDocument();
    expect(bar()).toHaveAttribute("aria-valuenow", "97");
  });

  it("keeps an old agent's bar indeterminate when only server-side stages arrive", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });
    send(update({ status: "running" }));
    expect(screen.getByText("Starting the update")).toBeInTheDocument();
    expect(bar()).toHaveAttribute("data-indeterminate", "true");
    send(update({ status: "running", stage: "restarting" }));
    expect(screen.getByText("Restarting the agent")).toBeInTheDocument();
    expect(bar()).toHaveAttribute("data-indeterminate", "true");
  });

  it("on completion refetches once: Installed shows the new version and Outdated clears", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });
    expect(getStates).toHaveBeenCalledTimes(1);
    send(update({ status: "running", stage: "confirming", progress: 97 }));

    getStates.mockResolvedValue(states("2.1.31"));
    send(update({ status: "completed", progress: null, stage: null, duration_seconds: 102 }));
    expect(await screen.findByText("Updated to 2.1.31")).toBeInTheDocument();
    await waitFor(() => expect(getStates).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByText("2.1.31").length).toBeGreaterThanOrEqual(2); // installed + desired
    expect(screen.getByText("took 1:42")).toBeInTheDocument();
    // Another event for the same finished action does not refetch again.
    send(update({ status: "completed", progress: null, stage: null }));
    act(() => emit({ type: "device_updated", data: { id: 7 } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(getStates).toHaveBeenCalledTimes(2);
  });

  it("refetches on device_updated when the completion refetch came before the new version was stored", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });
    send(update({ status: "running", stage: "confirming", progress: 97 }));
    send(update({ status: "completed" }));
    await waitFor(() => expect(getStates).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Outdated")).toBeInTheDocument();

    getStates.mockResolvedValue(states("2.1.31"));
    act(() => emit({ type: "device_updated", data: { id: 99 } })); // another device
    act(() => emit({ type: "device_updated", data: { id: 7 } }));
    await waitFor(() => expect(getStates).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());
  });

  it("reads once more when device_updated lands while a stale completion read is in flight", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });
    let answer: (value: DeviceComponentStatesResponse) => void = () => {};
    getStates.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    send(update({ status: "running", stage: "confirming", progress: 97 }));
    send(update({ status: "completed" }));
    await waitFor(() => expect(getStates).toHaveBeenCalledTimes(2));
    act(() => emit({ type: "device_updated", data: { id: 7 } }));
    expect(getStates).toHaveBeenCalledTimes(2); // waits for the read in flight
    getStates.mockResolvedValue(states("2.1.31"));
    await act(async () => answer(states("2.1.30")));
    await waitFor(() => expect(getStates).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());
  });

  it("shows a failure with its reason and retries the update", async () => {
    render(<ComponentStatesPanel deviceId={7} />);
    await screen.findByRole("button", { name: /Update/ });
    send(update({ status: "running", stage: "downloading", progress: 30 }));
    send(update({ status: "failed", error_message: "sha256 mismatch: package rejected" }));

    const block = await screen.findByTestId("agent-update-live");
    expect(within(block).getByRole("alert")).toHaveTextContent("Update failed");
    expect(within(block).getByText("sha256 mismatch: package rejected")).toBeInTheDocument();

    retryAction.mockResolvedValue({
      component_id: "agent",
      operation: "update",
      action_type: "self_update",
      label: "Update",
      action: {
        id: 51,
        device_id: 7,
        action_type: "self_update",
        status: "queued",
        created_at: new Date().toISOString(),
      },
    });
    fireEvent.click(within(block).getByRole("button", { name: "Retry update" }));
    await waitFor(() => expect(retryAction).toHaveBeenCalledWith(7, 50));
    expect(await screen.findByText("Queued — goes out at once over the live channel")).toBeInTheDocument();
    expect(screen.queryByText("sha256 mismatch: package rejected")).toBeNull();
  });

  it("cancels while queued and brings the buttons back", async () => {
    cancelAction.mockResolvedValue(update({ status: "cancelled" }));
    const onActionChange = vi.fn();
    render(<ComponentStatesPanel deviceId={7} onActionChange={onActionChange} />);
    await screen.findByRole("button", { name: /Update/ });
    send(update(), "action_queued");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelAction).toHaveBeenCalledWith(50));
    expect(await screen.findByText("Update cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update/ })).toBeInTheDocument();
    // The drawer's history hears about every copy.
    expect(onActionChange).toHaveBeenCalledWith(expect.objectContaining({ id: 50, status: "cancelled" }));
  });

  it("picks up an update already under way from the drawer's history", async () => {
    render(
      <ComponentStatesPanel
        deviceId={7}
        actions={[update({ status: "running", stage: "downloading", progress: 60 })]}
      />,
    );
    expect(await screen.findByText("Downloading 60%")).toBeInTheDocument();
  });

  it("with the socket down, re-reads the actions at the fallback cadence only while an update runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    socketStatus = "fallback";
    getDeviceActions.mockResolvedValue([update({ status: "running", stage: "installing", progress: 90 })]);
    render(
      <ComponentStatesPanel
        deviceId={7}
        actions={[update({ status: "running", stage: "downloading", progress: 60 })]}
      />,
    );
    expect(await screen.findByText("Downloading 60%")).toBeInTheDocument();
    expect(getDeviceActions).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getDeviceActions).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Installing")).toBeInTheDocument();
  });

  it("does not poll when the socket is up or nothing is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ComponentStatesPanel
        deviceId={7}
        actions={[update({ status: "running", stage: "downloading", progress: 60 })]}
      />,
    );
    await screen.findByText("Downloading 60%");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(getDeviceActions).not.toHaveBeenCalled();
  });
});
