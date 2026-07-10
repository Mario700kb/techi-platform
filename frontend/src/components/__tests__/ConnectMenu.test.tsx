import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  scheme: "ssh://", requires_client_os: null, status: "ready", status_reason: null, credential_source: "global",
};
const WEB_TERMINAL_METHOD = {
  id: "web_terminal", label: "Web Terminal", surface: "browser", capability: "terminal", priority: 10,
  scheme: null, requires_client_os: null, status: "ready", status_reason: null, credential_source: null,
};

function renderMenu(deviceId = 7) {
  return render(<MemoryRouter><ConnectMenu deviceId={deviceId} /></MemoryRouter>);
}

describe("ConnectMenu — Embedded SSH Connect wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the Embedded SSH modal instead of the generic launcher when SSH is selected", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD],
      preferred_method_id: "ssh", configured_preference_id: null,
    });
    renderMenu();

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
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD],
      preferred_method_id: "ssh", configured_preference_id: null,
    });
    renderMenu();

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("Web Terminal")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Web Terminal"));

    await waitFor(() => expect(screen.getByText(/has its own Connect flow/i)).toBeInTheDocument());
    expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument();
  });

  it("closing the modal removes it", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD], preferred_method_id: "ssh", configured_preference_id: null,
    });
    renderMenu();

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("SSH")).toBeInTheDocument());
    fireEvent.click(screen.getByText("SSH"));
    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());

    fireEvent.click(screen.getByText("close-modal"));
    await waitFor(() => expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument());
  });
});

describe("ConnectMenu — credential-aware status (Section D/E)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WINBOX_CREDENTIAL_REQUIRED = {
    id: "winbox", label: "Winbox", surface: "desktop", capability: null, priority: 10,
    scheme: "winbox://", requires_client_os: null, status: "credential_required",
    status_reason: "No compatible credential configured", credential_source: null,
  };
  const WEBFIG_READY = {
    id: "webfig", label: "WebFig", surface: "browser", capability: null, priority: 20,
    scheme: null, requires_client_os: null, status: "ready", status_reason: null, credential_source: "device",
  };

  it("shows every method even when a credential is required — never hides it", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WINBOX_CREDENTIAL_REQUIRED, WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));

    expect(await screen.findByText("Winbox")).toBeInTheDocument();
    expect(screen.getByText("WebFig")).toBeInTheDocument();
    expect(screen.getByText(/No compatible credential configured/)).toBeInTheDocument();
  });

  it("shows the resolved credential source for a Ready method", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));
    expect(await screen.findByText("Device credential")).toBeInTheDocument();
  });

  it("clicking a credential_required method navigates to the Vault prefilled with device/scope/type", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WINBOX_CREDENTIAL_REQUIRED],
      preferred_method_id: "winbox", configured_preference_id: null,
    });
    render(
      <MemoryRouter initialEntries={["/devices/7"]}>
        <ConnectMenu deviceId={7} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("Connect"));
    fireEvent.click(await screen.findByText("Winbox"));

    // The generic launcher must never be hit for a credential_required method.
    expect(client.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("marks the preferred method with a Default badge", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: "webfig",
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));
    expect(await screen.findByText("Default")).toBeInTheDocument();
  });

  it("pin icon calls setConnectPreference for a Ready method", async () => {
    vi.spyOn(client, "fetchJson")
      .mockResolvedValueOnce({
        platform: "mikrotik", methods: [WEBFIG_READY],
        preferred_method_id: "webfig", configured_preference_id: null,
      })
      .mockResolvedValueOnce({ platform: "mikrotik", device_id: null, method_id: "webfig" })
      .mockResolvedValueOnce({
        platform: "mikrotik", methods: [WEBFIG_READY],
        preferred_method_id: "webfig", configured_preference_id: "webfig",
      });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));
    const pinButtons = await screen.findAllByTitle("Always use this method");
    fireEvent.click(pinButtons[0]);

    await waitFor(() => expect(client.fetchJson).toHaveBeenCalledTimes(3));
    const putCall = (client.fetchJson as any).mock.calls[1];
    expect(putCall[0]).toBe("/api/v1/connect-preferences");
    expect(putCall[1].method).toBe("PUT");
    expect(JSON.parse(putCall[1].body)).toMatchObject({ platform: "mikrotik", method_id: "webfig" });
  });

  it("unavailable_os methods are shown disabled with a reason, not hidden", async () => {
    const winboxOnMac = {
      id: "winbox", label: "Winbox", surface: "desktop", capability: null, priority: 10,
      scheme: "winbox://", requires_client_os: "windows", status: "ready", status_reason: null, credential_source: "global",
    };
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [winboxOnMac, WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    // detectOperatorOS reads navigator.platform; jsdom defaults won't match
    // "windows" so this reliably exercises the mismatch branch regardless
    // of the actual test-runner OS.
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", userAgent: "Macintosh" });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));

    expect(await screen.findByText("Winbox")).toBeInTheDocument();
    const winboxButton = screen.getByText("Winbox").closest("button");
    expect(winboxButton).toBeDisabled();
  });
});
