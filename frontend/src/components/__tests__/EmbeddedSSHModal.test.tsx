import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmbeddedSSHModal from "../EmbeddedSSHModal";
import * as terminalApi from "../../api/terminal";

// DeviceTerminal/SSHSessionInfo do real WebSocket/xterm work — irrelevant to
// what this modal is responsible for (credential resolution branching), so
// they're mocked to a simple marker rendering the props they received.
vi.mock("../DeviceTerminal", () => ({
  default: (props: any) => (
    <div data-testid="device-terminal">
      mode={props.mode} credentialId={props.sshOptions?.credentialId ?? ""} tempUser=
      {props.sshOptions?.temporaryUsername ?? ""}
    </div>
  ),
}));
vi.mock("../SSHSessionInfo", () => ({
  default: () => <div data-testid="ssh-session-info" />,
}));

describe("EmbeddedSSHModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a clear message and a Temporary Session form when no credential resolves", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({ tier: "none", candidates: [] });
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/No SSH credential is available/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    expect(screen.queryByTestId("device-terminal")).not.toBeInTheDocument();
  });

  it("auto-connects when exactly one credential resolves", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({
      tier: "device",
      candidates: [{ id: 42, name: "device-cred", username: "root", credential_type: "ssh_password" }],
    });
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("device-terminal")).toBeInTheDocument());
    expect(screen.getByTestId("device-terminal").textContent).toContain("mode=ssh");
    expect(screen.getByTestId("device-terminal").textContent).toContain("credentialId=42");
  });

  it("shows a selector when multiple credentials resolve, and connects with the chosen one", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({
      tier: "global",
      candidates: [
        { id: 1, name: "cred-a", username: "root", credential_type: "ssh_password" },
        { id: 2, name: "cred-b", username: "admin", credential_type: "ssh_password" },
      ],
    });
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("cred-a")).toBeInTheDocument());
    expect(screen.getByText("cred-b")).toBeInTheDocument();
    expect(screen.queryByTestId("device-terminal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("cred-b"));
    await waitFor(() => expect(screen.getByTestId("device-terminal")).toBeInTheDocument());
    expect(screen.getByTestId("device-terminal").textContent).toContain("credentialId=2");
  });

  it("starts a Temporary Session only after the operator explicitly submits one", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({ tier: "none", candidates: [] });
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={vi.fn()} />);

    await waitFor(() => expect(screen.getByPlaceholderText("Username")).toBeInTheDocument());
    // Never falls back to the terminal before the operator fills in and submits the form.
    expect(screen.queryByTestId("device-terminal")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "root" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "swordfish" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByTestId("device-terminal")).toBeInTheDocument());
    expect(screen.getByTestId("device-terminal").textContent).toContain("tempUser=root");
  });

  it("shows an error message when credential resolution fails", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockRejectedValue(new Error("boom"));
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  it("calls onOpenExternal for the secondary 'open in your own SSH client' link", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({ tier: "none", candidates: [] });
    const onOpenExternal = vi.fn();
    render(<EmbeddedSSHModal deviceId={7} onClose={vi.fn()} onOpenExternal={onOpenExternal} />);

    await waitFor(() => expect(screen.getByText(/Open in your own SSH client instead/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Open in your own SSH client instead/i));
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is clicked", async () => {
    vi.spyOn(terminalApi, "getSshCredentialCandidates").mockResolvedValue({ tier: "none", candidates: [] });
    const onClose = vi.fn();
    render(<EmbeddedSSHModal deviceId={7} onClose={onClose} onOpenExternal={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Close")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
