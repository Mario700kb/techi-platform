import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConnectMenu from "../ConnectMenu";
import * as client from "../../api/client";

vi.mock("../EmbeddedSSHModal", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="embedded-ssh-modal">
      <button type="button" onClick={onClose}>close-modal</button>
    </div>
  ),
}));

const SSH_METHOD = {
  id: "ssh", label: "SSH", surface: "desktop", capability: "terminal", priority: 20,
  scheme: "ssh://", requires_client_os: null,
};
const WEB_TERMINAL_METHOD = {
  id: "web_terminal", label: "Web Terminal", surface: "browser", capability: "terminal", priority: 10,
  scheme: null, requires_client_os: null,
};

describe("ConnectMenu — Embedded SSH Connect wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the Embedded SSH modal instead of the generic launcher when SSH is selected", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({ platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD] });
    render(<ConnectMenu deviceId={7} />);

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("SSH")).toBeInTheDocument());
    fireEvent.click(screen.getByText("SSH"));

    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());
    // The generic launcher endpoint must never be called for "ssh" — only
    // the initial /connect-methods list fetch.
    expect(client.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("still shows the dedicated-flow note for web_terminal, not the SSH modal", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({ platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD] });
    render(<ConnectMenu deviceId={7} />);

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("Web Terminal")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Web Terminal"));

    await waitFor(() => expect(screen.getByText(/has its own Connect flow/i)).toBeInTheDocument());
    expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument();
  });

  it("closing the modal removes it", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({ platform: "linux", methods: [SSH_METHOD] });
    render(<ConnectMenu deviceId={7} />);

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("SSH")).toBeInTheDocument());
    fireEvent.click(screen.getByText("SSH"));
    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());

    fireEvent.click(screen.getByText("close-modal"));
    await waitFor(() => expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument());
  });
});
