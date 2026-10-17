import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PowerShellConsole from "../PowerShellConsole";
import type { TerminalHandle } from "../../DeviceTerminal";
import type { ConsoleScript } from "../../../api/terminal";
import { appCache } from "../../../store/appCache";

const listScripts = vi.fn();
const runScript = vi.fn();

vi.mock("../../../api/terminal", async (importActual) => ({
  ...(await importActual<typeof import("../../../api/terminal")>()),
  listConsoleScripts: (...a: unknown[]) => listScripts(...a),
  runConsoleScript: (...a: unknown[]) => runScript(...a),
}));

interface FakeProps {
  banner?: string;
  handleRef?: MutableRefObject<TerminalHandle | null>;
  onOpen?: () => void;
  onTitleChange?: (t: string) => void;
  onClosed?: (text: string) => void;
}
let terminal: FakeProps = {};
const send = vi.fn(() => true);
const close = vi.fn();

// The real console needs a socket and a canvas; this one exposes its callbacks.
vi.mock("../../DeviceTerminal", () => ({
  default: (props: FakeProps) => {
    terminal = props;
    if (props.handleRef) props.handleRef.current = { send, close, focus: () => undefined };
    return <div data-testid="fake-terminal">{props.banner}</div>;
  },
}));

const SESSION = {
  session_id: "ps-7",
  operator_ws_path: "wss://x/ws/terminal/ps-7?ticket=t",
  operator_ticket: "t",
  expires_in_seconds: 60,
};

function script(id: number, name: string, uses: number): ConsoleScript {
  return {
    id,
    name,
    description: `${name} description`,
    body: `Write-Output "${name}"`,
    version: 2,
    uses,
    last_used_at: null,
    updated_by: "ana.owner",
    updated_at: "2026-10-17T10:00:00Z",
  };
}

const SCRIPTS = [
  script(1, "Clear print queue", 12),
  script(2, "Flush DNS", 30),
  script(3, "Disk cleanup", 4),
  script(4, "Restart spooler", 9),
  script(5, "List services", 1),
  script(6, "Rarely used", 0),
];

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function renderConsole(onEnd = vi.fn()) {
  render(
    <PowerShellConsole
      layout="window"
      deviceId={9}
      deviceName="Mario-Lenovo"
      clientName="Northwind Clinic"
      signedInUser="mario"
      osCaption="Microsoft Windows 11 Pro"
      session={SESSION}
      onEnd={onEnd}
      onNewSession={vi.fn()}
    />,
  );
  return { onEnd };
}

const open = () => act(() => terminal.onOpen?.());
const title = (t: string) => act(() => terminal.onTitleChange?.(t));

describe("PowerShellConsole", () => {
  beforeEach(() => {
    appCache.invalidate();
    terminal = {};
    send.mockClear();
    close.mockClear();
    listScripts.mockReset().mockResolvedValue(SCRIPTS);
    runScript.mockReset();
  });

  it("draws the header, a local banner and the session details", async () => {
    renderConsole();
    expect(screen.getByRole("heading", { name: "Mario-Lenovo · PowerShell (Administrator)" })).toBeInTheDocument();
    expect(
      screen.getByText("Northwind Clinic · #9 · runs as NT AUTHORITY\\SYSTEM over the live channel"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("fake-terminal")).toHaveTextContent(
      /Session started by .* at \d\d:\d\d:\d\d after a 2FA code · Microsoft Windows 11 Pro/,
    );
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    open();
    expect(screen.getByText("Recording", { selector: ".ps-chip" })).toBeInTheDocument();
    expect(screen.getByText(/idle closes in 1[45]:\d\d/)).toBeInTheDocument();

    const details = screen.getByTestId("ps-session-details");
    expect(within(details).getByText("SYSTEM")).toBeInTheDocument();
    expect(within(details).getByText(/· 2FA confirmed/)).toBeInTheDocument();
    expect(within(details).getByText("mario")).toBeInTheDocument();
    expect(within(details).getByText(/kept 180 days/)).toBeInTheDocument();
    // 2.1.29 until a title says otherwise: no failure count, no version.
    expect(screen.getByTestId("ps-command-count")).toHaveTextContent("0 · —");
  });

  it("builds the command list from the agent's title markers", async () => {
    renderConsole();
    await screen.findByTestId("fake-terminal");
    open();
    title("techi;5.1.19041.4648;0;0;0;");
    title(`techi;5.1.19041.4648;1;0;12;${b64("Get-Service spooler")}`);
    title(`techi;5.1.19041.4648;2;1;340;${b64("Get-Item C:\\nope")}`);
    title("not a marker");

    expect(screen.getByText("5.1.19041.4648")).toBeInTheDocument();
    expect(screen.getByTestId("ps-command-count")).toHaveTextContent("2 · 1 failed");
    const list = screen.getByRole("list", { name: "Commands this session" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".ps-command-text")?.textContent)).toEqual([
      "Get-Service spooler",
      "Get-Item C:\\nope",
    ]);
    expect(rows[1]).toHaveTextContent("failed");
    expect(rows[1]).toHaveAttribute("title", "Get-Item C:\\nope\ntook 340 ms");
  });

  it("sends the command bar over the console and lists it (2.1.29 fallback)", async () => {
    renderConsole();
    await screen.findByTestId("fake-terminal");
    const input = screen.getByLabelText("Command");
    expect(input).toBeDisabled();
    open();
    fireEvent.change(input, { target: { value: "ipconfig\nwhoami" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).toHaveBeenCalledWith("ipconfig\rwhoami\r");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(send).toHaveBeenLastCalledWith("\x03");
    expect(screen.getByTestId("ps-command-count")).toHaveTextContent("1 · —");
  });

  it("runs a saved script: confirm, audit on the platform, then type its line", async () => {
    runScript.mockResolvedValue({
      command: "& ([scriptblock]::Create('...'))  # TECHI script: Flush DNS v2",
      script: { ...SCRIPTS[1], uses: 31 },
    });
    renderConsole();
    const list = await screen.findByRole("list", { name: "Saved scripts" });
    // Top five by use, most used first.
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".ps-script-name")?.textContent),
    ).toEqual(["Flush DNS", "Clear print queue", "Restart spooler", "Disk cleanup", "List services"]);
    expect(within(list).getByRole("button", { name: "Run Flush DNS" })).toBeDisabled();
    open();
    fireEvent.click(within(list).getByRole("button", { name: "Run Flush DNS" }));

    const dialog = await screen.findByRole("dialog", { name: "Run “Flush DNS”" });
    expect(within(dialog).getByLabelText("Script body")).toHaveValue('Write-Output "Flush DNS"');
    expect(runScript).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Run as SYSTEM/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(runScript).toHaveBeenCalledWith(9, "ps-7", 2);
    expect(send).toHaveBeenCalledWith("& ([scriptblock]::Create('...'))  # TECHI script: Flush DNS v2\r");
    expect(runScript.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    const commands = screen.getByRole("list", { name: "Commands this session" });
    expect(within(commands).getByText("Script · Flush DNS")).toBeInTheDocument();
  });

  it("shows why a script could not run and sends nothing", async () => {
    runScript.mockRejectedValue(new Error("This session is not yours."));
    renderConsole();
    const list = await screen.findByRole("list", { name: "Saved scripts" });
    open();
    fireEvent.click(within(list).getByRole("button", { name: "Run Flush DNS" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Run as SYSTEM/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This session is not yours.");
    expect(send).not.toHaveBeenCalled();
  });

  it("ends the session: closes the socket and offers the transcript", async () => {
    const { onEnd } = renderConsole();
    await screen.findByTestId("fake-terminal");
    open();
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(close).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    // In the header and in the bar that replaces the command line.
    expect(screen.getAllByRole("button", { name: /Download transcript/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /New session/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Command")).toBeNull();
  });
});
