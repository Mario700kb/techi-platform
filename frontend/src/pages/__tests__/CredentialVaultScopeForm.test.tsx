import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chooseOption } from "../../test/select";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import CredentialVault from "../CredentialVault";
import * as vaultApi from "../../api/vault";
import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import * as authContext from "../../auth/AuthContext";

// Regression coverage for the production bug: creating a Device-scoped
// credential sent client_id alongside device_id (the picker's narrowing
// filter was reused as the submitted field), which the backend correctly
// rejected with "scope 'device' must not set client_id". Also covers the
// previously entirely-missing Group scope UI.

const TYPES: vaultApi.VaultCredentialTypeDescriptor[] = [
  {
    id: "generic_username_password", label: "Generic username/password", icon: "UserCog", category: "generic",
    metadata_fields: [], secret_fields: [{ key: "password", label: "Password", required: true, kind: "password", options: null, default: null, placeholder: null }],
    requires_username: true, requires_secret: true, future_consumers: ["Other"], legacy: false,
  },
];

const CLIENTS: clientsApi.Client[] = [
  { id: 100, name: "Acme", slug: "acme", is_active: true, created_at: "2026-01-01T00:00:00Z" },
];

const GROUPS: clientsApi.DeviceGroup[] = [
  { id: 5, client_id: 100, name: "Network", created_at: "2026-01-01T00:00:00Z" },
];

function credential(overrides: Partial<vaultApi.VaultCredential> = {}): vaultApi.VaultCredential {
  return {
    id: 1, name: "cred", credential_type: "generic_username_password", scope_type: "global",
    client_id: null, group_id: null, device_id: null, purpose: null, username: "admin", notes: null,
    created_by: "mario", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    rotated_at: null, last_used_at: null, status: "active", expires_at: null, rotation_due_at: null,
    last_tested_at: null, last_test_status: null, credential_metadata: {}, secret_hint: "••••1234",
    lifecycle_status: "active", is_referenced: false, reference_count: 0, references: [],
    consumer_status: "stored_only", future_consumers: [],
    ...overrides,
  };
}

function mockAuth() {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "op", display_name: "Op", role: "admin", email: "" } as any,
    token: "t", loading: false, permissions: null,
    login: vi.fn(), logout: vi.fn(), can: () => true, hasAnyRole: vi.fn(), hasPermission: () => true,
  });
}

function renderPage() {
  return render(<MemoryRouter><CredentialVault /></MemoryRouter>);
}

async function openForm() {
  await waitFor(() => expect(screen.getByText("New credential")).toBeInTheDocument());
  fireEvent.click(screen.getByText("New credential"));
  await waitFor(() => expect(screen.getByPlaceholderText("Name")).toBeInTheDocument());
}

function fillCommonFields() {
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "test-cred" } });
  fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "root" } });
  fireEvent.change(screen.getByPlaceholderText("Password *"), { target: { value: "hunter2" } });
}

async function selectScope(scope: "global" | "client" | "group" | "device") {
  await chooseOption("Scope", scope);
}

async function pickFromSearchSelect(placeholder: string, optionLabel: string) {
  const trigger = await screen.findByText(placeholder);
  fireEvent.click(trigger);
  const listbox = await screen.findByRole("listbox", { name: placeholder });
  const option = await within(listbox).findByText(optionLabel, {}, { timeout: 2000 });
  fireEvent.click(option);
}

describe("CredentialVault — scope payload regression (device/client/group)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Client scope sends only client_id", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue(CLIENTS);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue(GROUPS);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);
    const createSpy = vi.spyOn(vaultApi, "createVaultCredential").mockResolvedValue(credential({ scope_type: "client", client_id: 100 }));

    renderPage();
    await openForm();
    await selectScope("client");
    await pickFromSearchSelect("Select client", "Acme");
    fillCommonFields();
    fireEvent.click(screen.getByText("Add credential"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const payload = createSpy.mock.calls[0][0];
    expect(payload.scope_type).toBe("client");
    expect(payload.client_id).toBe(100);
    expect(payload.group_id).toBeNull();
    expect(payload.device_id).toBeNull();
  });

  it("Group scope sends only group_id — never client_id (group scope UI previously didn't exist)", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue(CLIENTS);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue(GROUPS);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);
    const createSpy = vi.spyOn(vaultApi, "createVaultCredential").mockResolvedValue(credential({ scope_type: "group", group_id: 5 }));

    renderPage();
    await openForm();
    await selectScope("group");
    await pickFromSearchSelect("Filter by client (optional)", "Acme");
    await pickFromSearchSelect("Select group", "Network");
    fillCommonFields();
    fireEvent.click(screen.getByText("Add credential"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const payload = createSpy.mock.calls[0][0];
    expect(payload.scope_type).toBe("group");
    expect(payload.group_id).toBe(5);
    expect(payload.client_id).toBeNull();
    expect(payload.device_id).toBeNull();
  });

  it("Device scope sends only device_id — the client filter picker must NEVER be submitted as client_id (root cause of the production 400)", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue(CLIENTS);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue(GROUPS);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);
    vi.spyOn(devicesApi, "getDevices").mockResolvedValue({
      devices: [{ id: 733, hostname: "mario-home", display_name: "Mario Home", client_id: 100, group_id: 5, platform: "linux" } as devicesApi.Device],
      total: 1,
    });
    const createSpy = vi.spyOn(vaultApi, "createVaultCredential").mockResolvedValue(credential({ scope_type: "device", device_id: 733 }));

    renderPage();
    await openForm();
    await selectScope("device");
    await pickFromSearchSelect("Filter by client (optional)", "Acme");
    // Device picker is async (loadOptions) — open it and wait for the debounced search.
    fireEvent.click(await screen.findByText("Search device by hostname…"));
    const deviceListbox = await screen.findByRole("listbox", { name: "Search device by hostname…" });
    const deviceOption = await within(deviceListbox).findByText("Mario Home", {}, { timeout: 2000 });
    fireEvent.click(deviceOption);
    fillCommonFields();
    fireEvent.click(screen.getByText("Add credential"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const payload = createSpy.mock.calls[0][0];
    expect(payload.scope_type).toBe("device");
    expect(payload.device_id).toBe(733);
    // The exact bug: client_id must be null even though a client was chosen
    // to filter the device dropdown.
    expect(payload.client_id).toBeNull();
    expect(payload.group_id).toBeNull();
  });

  it("switching scope away from Client clears the previously selected client (no stale field leaks into a later submit)", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue(CLIENTS);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue(GROUPS);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);
    const createSpy = vi.spyOn(vaultApi, "createVaultCredential").mockResolvedValue(credential({ scope_type: "global" }));

    renderPage();
    await openForm();
    await selectScope("client");
    await pickFromSearchSelect("Select client", "Acme");
    // Switch back to Global — the client picker must disappear entirely.
    await selectScope("global");
    expect(screen.queryByText("Select client")).not.toBeInTheDocument();

    fillCommonFields();
    fireEvent.click(screen.getByText("Add credential"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const payload = createSpy.mock.calls[0][0];
    expect(payload.scope_type).toBe("global");
    expect(payload.client_id).toBeNull();
    expect(payload.group_id).toBeNull();
    expect(payload.device_id).toBeNull();
  });
});

describe("CredentialVault — 'Add credential' prefill from Connect menu (Section D/E)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the form pre-filled with device scope + credential type from the query params", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue(CLIENTS);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue(GROUPS);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);
    vi.spyOn(devicesApi, "getDevice").mockResolvedValue({
      id: 733, hostname: "mario-home", display_name: "Mario Home", client_id: 100,
    } as devicesApi.Device);

    render(
      <MemoryRouter initialEntries={["/vault?prefill_scope=device&prefill_device_id=733&prefill_credential_type=ssh_password"]}>
        <CredentialVault />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("New credential")).toBeInTheDocument());
    // Form auto-opens (title switches from the "New credential" button to
    // the form's own heading, which also reads "New credential").
    await waitFor(() => expect(screen.getByText("Mario Home")).toBeInTheDocument());
  });
});
