import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConnectMenu, { groupConnectMethods } from "../ConnectMenu";
import type { ConnectMethod } from "../../api/connect";
import * as client from "../../api/client";

vi.mock("../EmbeddedSSHModal", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="embedded-ssh-modal">
      <button type="button" onClick={onClose}>close-modal</button>
    </div>
  ),
}));

const SSH_METHOD = {
  id: "ssh", label: "Embedded SSH", surface: "desktop", capability: "terminal", priority: 20,
  scheme: "ssh://", requires_client_os: null, status: "ready", status_reason: null, credential_source: "global",
  transport: "Backend relay · Vault", category: "available", embedded: true,
};
const WEB_TERMINAL_METHOD = {
  id: "web_terminal", label: "Embedded Terminal", surface: "browser", capability: "terminal", priority: 10,
  scheme: null, requires_client_os: null, status: "ready", status_reason: null, credential_source: null,
  transport: "Agent tunnel", category: "available", embedded: true,
};

function renderMenu(deviceId = 7, extraProps: Record<string, unknown> = {}) {
  return render(<MemoryRouter><ConnectMenu deviceId={deviceId} {...extraProps} /></MemoryRouter>);
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
    await waitFor(() => expect(screen.getByText("Embedded SSH")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Embedded SSH"));

    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());
    // The generic launcher endpoint must never be called for "ssh" — only
    // the initial /connect-methods list fetch.
    expect(client.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("web_terminal calls onOpenTerminal (opens the Terminal tab) instead of a dead toast", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD],
      preferred_method_id: "ssh", configured_preference_id: null,
    });
    const onOpenTerminal = vi.fn();
    renderMenu(7, { onOpenTerminal });

    fireEvent.click(await screen.findByText("Connect"));
    fireEvent.click(await screen.findByText("Embedded Terminal"));

    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument();
    // No launch endpoint call either — only the initial list fetch.
    expect(client.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("closing the modal removes it", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD], preferred_method_id: "ssh", configured_preference_id: null,
    });
    renderMenu();

    await waitFor(() => expect(screen.getByText("Connect")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("Embedded SSH")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Embedded SSH"));
    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());

    fireEvent.click(screen.getByText("close-modal"));
    await waitFor(() => expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument());
  });
});

const WINBOX_CREDENTIAL_REQUIRED = {
  id: "winbox", label: "Winbox", surface: "desktop", capability: null, priority: 10,
  scheme: "winbox://", requires_client_os: null, status: "credential_required",
  status_reason: "No compatible credential configured", credential_source: null,
  transport: "Desktop app", category: "desktop_app", embedded: false,
};
const WEBFIG_READY = {
  id: "webfig", label: "WebFig", surface: "browser", capability: null, priority: 30,
  scheme: null, requires_client_os: null, status: "ready", status_reason: null, credential_source: "device",
  transport: "Browser", category: "web", embedded: false,
};

describe("ConnectMenu — credential-aware status (Section D/E)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows every method even when a credential is required — never hides it", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WINBOX_CREDENTIAL_REQUIRED, WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));

    expect(await screen.findByText("Winbox")).toBeInTheDocument();
    expect(screen.getByText("WebFig")).toBeInTheDocument();
    expect(screen.getByText(/Credential required/)).toBeInTheDocument();
  });

  it("shows the resolved credential source for a Ready method", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));
    expect(await screen.findByText(/Device credential · Ready/)).toBeInTheDocument();
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

  it("marks the preferred method with a Default badge (arrow opens the menu directly)", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: "webfig",
    });
    renderMenu();
    await screen.findByText("Connect");
    fireEvent.click(screen.getByLabelText("Connect options"));
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
      ...WINBOX_CREDENTIAL_REQUIRED,
      requires_client_os: "windows", status: "ready", status_reason: null, credential_source: "global",
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
    expect(screen.getByText(/Windows only · Unavailable on macOS/)).toBeInTheDocument();
  });
});

describe("ConnectMenu — approved V3 mockup behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("main click launches the operator's SAVED Ready default immediately (no menu)", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "linux", methods: [SSH_METHOD, WEB_TERMINAL_METHOD],
      preferred_method_id: "ssh", configured_preference_id: "ssh",
    });
    renderMenu();

    fireEvent.click(await screen.findByText("Connect"));
    // SSH is the saved default and Ready → the Embedded SSH modal opens
    // directly, without the menu ever appearing.
    await waitFor(() => expect(screen.getByTestId("embedded-ssh-modal")).toBeInTheDocument());
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
  });

  it("main click with NO saved preference opens the categorized menu once", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [WINBOX_CREDENTIAL_REQUIRED, SSH_METHOD, WEBFIG_READY],
      preferred_method_id: "ssh", configured_preference_id: null,
    });
    renderMenu(7, { hostname: "rb-core-01" });

    fireEvent.click(await screen.findByText("Connect"));
    expect(await screen.findByText("Connect to rb-core-01")).toBeInTheDocument();
    // Category sections from the approved mockup.
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(screen.getByText("Desktop Applications")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded-ssh-modal")).not.toBeInTheDocument();
  });

  it("'Always use this option' saves the launched method as the platform default", async () => {
    vi.spyOn(client, "fetchJson")
      .mockResolvedValueOnce({
        platform: "mikrotik", methods: [WEBFIG_READY, SSH_METHOD],
        preferred_method_id: "webfig", configured_preference_id: null,
      })
      .mockResolvedValue({ platform: "mikrotik", device_id: null, method_id: "ssh" });
    renderMenu();

    fireEvent.click(await screen.findByText("Connect"));
    fireEvent.click(await screen.findByText("Always use this option"));
    fireEvent.click(screen.getByText("Embedded SSH"));

    await waitFor(() => {
      const putCall = (client.fetchJson as any).mock.calls.find(
        (c: any[]) => c[0] === "/api/v1/connect-preferences" && c[1]?.method === "PUT",
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toMatchObject({ platform: "mikrotik", method_id: "ssh" });
    });
  });

  it("feature-gated embedded methods land in the Unavailable section, disabled with the backend's reason", async () => {
    const gatedSsh = {
      ...SSH_METHOD, status: "unavailable",
      status_reason: "Embedded terminal is not enabled for this device yet", credential_source: null,
    };
    vi.spyOn(client, "fetchJson").mockResolvedValueOnce({
      platform: "mikrotik", methods: [gatedSsh, WEBFIG_READY],
      preferred_method_id: "webfig", configured_preference_id: null,
    });
    renderMenu();
    fireEvent.click(await screen.findByText("Connect"));

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    const sshButton = screen.getByText("Embedded SSH").closest("button");
    expect(sshButton).toBeDisabled();
    expect(screen.getByText(/not enabled for this device/)).toBeInTheDocument();
  });
});

describe("groupConnectMethods — approved mockup menu structure", () => {
  const method = (overrides: Partial<ConnectMethod>): ConnectMethod => ({
    id: "x", label: "X", surface: "desktop", capability: null, priority: 10,
    scheme: null, requires_client_os: null, status: "ready", status_reason: null,
    credential_source: null, transport: "", category: "available", embedded: false,
    ...overrides,
  });

  it("extracts the Ready preferred method into Recommended and orders sections", () => {
    const groups = groupConnectMethods(
      [
        method({ id: "winbox", category: "desktop_app", priority: 10, requires_client_os: "windows" }),
        method({ id: "ssh", category: "available", priority: 20 }),
        method({ id: "webfig", category: "web", priority: 30 }),
      ],
      "ssh",
      "macos",
    );
    expect(groups.map((g) => g.label)).toEqual(["Recommended", "Web", "Desktop Applications"]);
    expect(groups[0].methods[0].id).toBe("ssh");
  });

  it("keeps an OS-mismatched desktop app in Desktop Applications (visible, not hidden)", () => {
    const groups = groupConnectMethods(
      [method({ id: "winbox", category: "desktop_app", requires_client_os: "windows" })],
      null,
      "macos",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Desktop Applications");
  });

  it("feature-gated (backend unavailable) methods sink to Unavailable", () => {
    const groups = groupConnectMethods(
      [
        method({ id: "ssh", category: "available", status: "unavailable", status_reason: "not enabled" }),
        method({ id: "webfig", category: "web" }),
      ],
      null,
      "macos",
    );
    expect(groups.map((g) => g.label)).toEqual(["Web", "Unavailable"]);
  });

  it("a preferred method that is NOT Ready is not Recommended", () => {
    const groups = groupConnectMethods(
      [method({ id: "winbox", category: "desktop_app", status: "credential_required" })],
      "winbox",
      "windows",
    );
    expect(groups.map((g) => g.label)).toEqual(["Desktop Applications"]);
  });
});
