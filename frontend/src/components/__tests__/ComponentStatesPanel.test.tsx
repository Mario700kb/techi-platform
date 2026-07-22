import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ComponentStatesPanel from "../ComponentStatesPanel";
import type {
  DeviceComponentStatesResponse,
  PlatformComponentsResponse,
} from "../../api/platform";

const getStates = vi.fn();
const getComponents = vi.fn();
const queueAction = vi.fn();

vi.mock("../../api/platform", () => ({
  getDeviceComponentStates: (...a: unknown[]) => getStates(...a),
  getPlatformComponents: (...a: unknown[]) => getComponents(...a),
  queueComponentAction: (...a: unknown[]) => queueAction(...a),
}));

const STATES: DeviceComponentStatesResponse = {
  schema_version: 1,
  device_id: 7,
  components: [
    {
      component_id: "agent",
      display_name: "TECHI Agent",
      icon_key: "agent",
      installed_version: "2.1.5",
      desired_version: "2.1.14",
      health: "outdated",
      status: "Outdated",
    },
    {
      component_id: "remote_support",
      display_name: "TECHI Remote Support",
      icon_key: "remote_support",
      installed_version: "1.4.8",
      desired_version: "1.4.8",
      health: "current",
      status: "Current",
    },
  ],
};

const COMPONENTS: PlatformComponentsResponse = {
  schema_version: 1,
  components: [
    {
      id: "agent", display_name: "TECHI Agent", description: "", icon_key: "agent",
      platforms: ["windows"], file_types: ["agent_binary"], capabilities: [],
      lifecycle: [
        { operation: "update", label: "Update", action_type: "self_update", kind: "action" },
        { operation: "restart", label: "Restart", action_type: "restart_agent", kind: "action" },
        { operation: "install", label: "Install", action_type: null, kind: "out_of_band" },
      ],
      policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
    },
    {
      id: "remote_support", display_name: "TECHI Remote Support", description: "", icon_key: "remote_support",
      platforms: ["windows"], file_types: ["remote_support_msi"], capabilities: ["remote_support"],
      lifecycle: [
        { operation: "reinstall", label: "Reinstall", action_type: "reinstall_rustdesk", kind: "action" },
      ],
      policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
    },
  ],
};

describe("ComponentStatesPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders installed/desired/status + lifecycle metadata per component", async () => {
    getStates.mockResolvedValue(STATES);
    getComponents.mockResolvedValue(COMPONENTS);
    render(<ComponentStatesPanel deviceId={7} />);

    await waitFor(() => expect(screen.getByText("TECHI Agent")).toBeInTheDocument());
    expect(screen.getByText("Outdated")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("2.1.5")).toBeInTheDocument();   // installed
    expect(screen.getByText("2.1.14")).toBeInTheDocument();  // desired
    // Lifecycle metadata chips (labels).
    await waitFor(() => expect(screen.getByText("Update")).toBeInTheDocument());
    expect(screen.getByText("Reinstall")).toBeInTheDocument();
  });

  it("triggers a component action for an executable operation and shows feedback", async () => {
    getStates.mockResolvedValue(STATES);
    getComponents.mockResolvedValue(COMPONENTS);
    queueAction.mockResolvedValue({
      component_id: "agent", operation: "update", action_type: "self_update",
      label: "Update", action: { id: 1, device_id: 7, action_type: "self_update", status: "queued", created_at: "" },
    });
    render(<ComponentStatesPanel deviceId={7} />);

    const updateBtn = await screen.findByRole("button", { name: /Update/ });
    fireEvent.click(updateBtn);

    await waitFor(() => expect(queueAction).toHaveBeenCalledWith(7, "agent", "update"));
    await waitFor(() => expect(screen.getByText("Update queued")).toBeInTheDocument());
  });

  it("surfaces a structured error when the action is rejected", async () => {
    getStates.mockResolvedValue(STATES);
    getComponents.mockResolvedValue(COMPONENTS);
    queueAction.mockRejectedValue(new Error("Permission denied: deployment"));
    render(<ComponentStatesPanel deviceId={7} />);

    const restartBtn = await screen.findByRole("button", { name: /Restart/ });
    fireEvent.click(restartBtn);

    await waitFor(() =>
      expect(screen.getByText("Permission denied: deployment")).toBeInTheDocument(),
    );
  });

  it("renders out-of-band operations as non-interactive labels", async () => {
    getStates.mockResolvedValue(STATES);
    getComponents.mockResolvedValue(COMPONENTS);
    render(<ComponentStatesPanel deviceId={7} />);

    await waitFor(() => expect(screen.getByText("Install")).toBeInTheDocument());
    // "Install" is out_of_band → not a button; "Update" is.
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Update/ })).toBeInTheDocument();
  });

  it("renders nothing for a device with no managed components", async () => {
    getStates.mockResolvedValue({ schema_version: 1, device_id: 9, components: [] });
    getComponents.mockResolvedValue(COMPONENTS);
    const { container } = render(<ComponentStatesPanel deviceId={9} />);
    await waitFor(() => expect(getStates).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing (no crash) when the endpoint fails", async () => {
    getStates.mockRejectedValue(new Error("404"));
    getComponents.mockRejectedValue(new Error("404"));
    const { container } = render(<ComponentStatesPanel deviceId={1} />);
    await waitFor(() => expect(getStates).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
