import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DevicePowerShellPanel, { endReason } from "../DevicePowerShellPanel";
import { parseCast } from "../ConsoleReplayModal";
import { appCache } from "../../store/appCache";
import type { ConsoleSessionSummary } from "../../api/terminal";

const createSession = vi.fn();
const listSessions = vi.fn();
const getRecording = vi.fn();
const terminalProps = vi.fn();

vi.mock("../../api/terminal", async (importActual) => ({
  ...(await importActual<typeof import("../../api/terminal")>()),
  createPowerShellSession: (...a: unknown[]) => createSession(...a),
  listConsoleSessions: (...a: unknown[]) => listSessions(...a),
  getConsoleRecording: (...a: unknown[]) => getRecording(...a),
  listConsoleScripts: () => Promise.resolve([]),
}));

// The real console needs a socket and a canvas; the panel only hands it the session.
vi.mock("../DeviceTerminal", () => ({
  default: (props: { session?: { session_id: string } }) => {
    terminalProps(props);
    return <div data-testid="fake-terminal">{props.session?.session_id}</div>;
  },
}));

const SESSIONS: ConsoleSessionSummary[] = [
  {
    session_id: "s-1",
    engine: "powershell",
    operator_username: "denis",
    status: "closed",
    created_at: "2026-10-17T10:00:00Z",
    started_at: "2026-10-17T10:00:05Z",
    ended_at: "2026-10-17T10:12:05Z",
    disconnect_reason: "idle_timeout",
    recording_bytes: 2048,
  },
  {
    session_id: "s-2",
    engine: "powershell",
    operator_username: "ana",
    status: "failed",
    created_at: "2026-10-16T10:00:00Z",
    started_at: null,
    ended_at: "2026-10-16T10:01:00Z",
    disconnect_reason: null,
    recording_bytes: null,
  },
];

const SESSION = {
  session_id: "new-1",
  operator_ws_path: "wss://x/ws/terminal/new-1?ticket=t",
  operator_ticket: "t",
  expires_in_seconds: 60,
};

function renderPanel(capable = true, kind: "powershell" | "linux" = "powershell") {
  return render(
    <DevicePowerShellPanel
      deviceId={9}
      deviceName="Mario-Lenovo"
      clientName="Northwind Clinic"
      currentUser="mario"
      capable={capable}
      active
      offline={false}
      kind={kind}
    />,
  );
}

describe("DevicePowerShellPanel", () => {
  beforeEach(async () => {
    appCache.invalidate();
    createSession.mockReset();
    listSessions.mockReset().mockResolvedValue(SESSIONS);
    getRecording.mockReset();
    terminalProps.mockReset();
  });

  it("explains what a device without the capability needs", () => {
    renderPanel(false);
    expect(screen.getByText("Needs agent 2.1.29 on Windows 10 1809 / Server 2019 or newer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open PowerShell/ })).toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("asks for a code every time, says why it failed, then embeds the console", async () => {
    const { PowerShellStepUpError } = await import("../../api/terminal");
    createSession
      .mockRejectedValueOnce(new PowerShellStepUpError("mfa_invalid", "bad"))
      .mockRejectedValueOnce(new PowerShellStepUpError("mfa_not_enabled", "off"))
      .mockResolvedValueOnce(SESSION);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Open PowerShell/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Runs as SYSTEM, with full rights on the device")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Two-factor code");

    fireEvent.change(input, { target: { value: "12a34 56" } });
    expect(input).toHaveValue("123456");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open PowerShell" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Wrong or expired code");
    expect(createSession).toHaveBeenCalledWith(9, "123456", "powershell");

    fireEvent.change(input, { target: { value: "654321" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open PowerShell" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Settings → Security"));

    fireEvent.change(input, { target: { value: "111111" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open PowerShell" }));
    expect(await screen.findByTestId("fake-terminal")).toHaveTextContent("new-1");
    expect(screen.queryByRole("dialog")).toBeNull();
    const console = screen.getByTestId("powershell-console");
    expect(within(console).getByText("Mario-Lenovo · PowerShell (Administrator)")).toBeInTheDocument();
    expect(
      within(console).getByText("Northwind Clinic · #9 · runs as NT AUTHORITY\\SYSTEM over the live channel"),
    ).toBeInTheDocument();
    expect(within(console).getByText(/idle closes in 1[45]:\d\d/)).toBeInTheDocument();
    expect(within(console).getByText("mario")).toBeInTheDocument();
    expect(terminalProps).toHaveBeenLastCalledWith(expect.objectContaining({ session: SESSION, bare: true }));

    fireEvent.click(within(console).getByRole("button", { name: "End session" }));
    expect(screen.queryByTestId("fake-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: /Open PowerShell/ })).toBeInTheDocument();
  });

  it("on Linux opens the root terminal with the same two-factor step, without PowerShell scripts", async () => {
    createSession.mockResolvedValueOnce(SESSION);
    renderPanel(true, "linux");
    expect(screen.getByText("Terminal · root")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open terminal/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Runs as root, with full rights on the device")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open terminal" }));
    expect(await screen.findByTestId("fake-terminal")).toHaveTextContent("new-1");
    expect(createSession).toHaveBeenCalledWith(9, "123456", "linux");
    const console = screen.getByTestId("powershell-console");
    expect(within(console).getByText("Mario-Lenovo · Terminal (root)")).toBeInTheDocument();
    expect(within(console).getByText("Northwind Clinic · #9 · runs as root over the live channel")).toBeInTheDocument();
    expect(within(console).queryByText(/Saved scripts/i)).toBeNull();
  });

  it("lists console history with replay and download", async () => {
    renderPanel();
    const list = await screen.findByRole("list", { name: "Console sessions" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("denis");
    expect(rows[0]).toHaveTextContent("12 min · Closed after 15 min idle · 2.0 KB");
    expect(rows[1]).toHaveTextContent("no recording");
    expect(within(rows[1]).getByRole("button", { name: /Replay/ })).toBeDisabled();

    getRecording.mockResolvedValue('{"version":2,"width":80,"height":24}\n[0.1,"o","PS C:\\\\> "]\n');
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(getRecording).toHaveBeenCalledWith(9, "s-1");
  });
});

describe("console helpers", () => {
  it("parses asciicast v2 output and resize events", () => {
    const cast = parseCast(
      ['{"version": 2, "width": 120, "height": 30}', '[0.5, "o", "hello"]', "not json", '[1.0, "r", "100x40"]'].join(
        "\n",
      ),
    );
    expect(cast.cols).toBe(120);
    expect(cast.rows).toBe(30);
    expect(cast.events).toEqual([
      [0.5, "o", "hello"],
      [1, "r", "100x40"],
    ]);
  });

  it("words why a session ended", () => {
    expect(endReason(SESSIONS[0])).toBe("Closed after 15 min idle");
    expect(endReason({ ...SESSIONS[0], disconnect_reason: null, status: "active" })).toBe("Open now");
    expect(endReason(SESSIONS[1])).toBe("Failed");
  });
});
