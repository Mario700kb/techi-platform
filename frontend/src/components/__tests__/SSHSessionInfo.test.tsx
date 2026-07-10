import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SSHSessionInfo from "../SSHSessionInfo";
import * as terminalApi from "../../api/terminal";

function detail(overrides: Partial<terminalApi.SSHSessionDetail> = {}): terminalApi.SSHSessionDetail {
  return {
    session_id: "s1",
    device_id: 7,
    device_hostname: "lin-1",
    client_id: 100,
    client_name: "Acme",
    operator_username: "mario",
    ssh_username: "root",
    credential_source: "device",
    status: "active",
    created_at: "2026-07-10T12:00:00Z",
    started_at: "2026-07-10T12:00:00Z",
    ended_at: null,
    duration_seconds: 0,
    idle_seconds: 0,
    disconnect_reason: null,
    ...overrides,
  };
}

describe("SSHSessionInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders device, client, operator, username, authentication source and status", async () => {
    vi.spyOn(terminalApi, "getSshSessionDetail").mockResolvedValue(detail());
    render(<SSHSessionInfo deviceId={7} sessionId="s1" />);

    await waitFor(() => expect(screen.getByText("lin-1")).toBeInTheDocument());
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("mario")).toBeInTheDocument();
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("Device")).toBeInTheDocument(); // credential_source label
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("maps every credential_source value to its display label", async () => {
    vi.spyOn(terminalApi, "getSshSessionDetail").mockResolvedValue(detail({ credential_source: "temporary" }));
    render(<SSHSessionInfo deviceId={7} sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Temporary Session")).toBeInTheDocument());
  });

  it("renders nothing before the first fetch resolves", () => {
    vi.spyOn(terminalApi, "getSshSessionDetail").mockReturnValue(new Promise(() => {}));
    const { container } = render(<SSHSessionInfo deviceId={7} sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not show Duration/Idle for a non-active (closed) session", async () => {
    vi.spyOn(terminalApi, "getSshSessionDetail").mockResolvedValue(
      detail({ status: "closed", started_at: null, duration_seconds: 42, idle_seconds: null }),
    );
    render(<SSHSessionInfo deviceId={7} sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("closed")).toBeInTheDocument());
    expect(screen.queryByText(/Duration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Idle/i)).not.toBeInTheDocument();
  });
});
