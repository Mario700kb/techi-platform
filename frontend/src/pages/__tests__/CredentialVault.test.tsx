import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import CredentialVault from "../CredentialVault";
import * as vaultApi from "../../api/vault";
import * as clientsApi from "../../api/clients";
import * as authContext from "../../auth/AuthContext";
import { ApiError } from "../../api/client";

const TYPES: vaultApi.VaultCredentialTypeDescriptor[] = [
  {
    id: "generic_username_password", label: "Generic username/password", icon: "UserCog", category: "generic",
    metadata_fields: [], secret_fields: [{ key: "password", label: "Password", required: true, kind: "password", options: null, default: null, placeholder: null }],
    requires_username: true, requires_secret: true, future_consumers: ["Other"], legacy: false,
  },
];

function credential(overrides: Partial<vaultApi.VaultCredential> = {}): vaultApi.VaultCredential {
  return {
    id: 1, name: "srv ssh", credential_type: "generic_username_password", scope_type: "global",
    client_id: null, group_id: null, device_id: null, purpose: null, username: "admin", notes: null,
    created_by: "mario", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    rotated_at: null, last_used_at: null, status: "active", expires_at: null, rotation_due_at: null,
    last_tested_at: null, last_test_status: null, credential_metadata: {}, secret_hint: "••••1234",
    lifecycle_status: "active", is_referenced: false, reference_count: 0, references: [],
    consumer_status: "stored_only", future_consumers: [],
    ...overrides,
  };
}

function mockAuth(overrides: Partial<ReturnType<typeof authContext.useAuth>> = {}) {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "op", display_name: "Op", role: "admin", email: "" } as any,
    token: "t", loading: false, permissions: null,
    login: vi.fn(), logout: vi.fn(), can: () => true, hasAnyRole: vi.fn(), hasPermission: () => true,
    ...overrides,
  });
}

function renderPage() {
  return render(<MemoryRouter><CredentialVault /></MemoryRouter>);
}

describe("CredentialVault enterprise UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state, then the credential list", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    let resolveList: (v: vaultApi.VaultCredential[]) => void = () => {};
    vi.spyOn(vaultApi, "listVaultCredentials").mockReturnValue(
      new Promise((resolve) => { resolveList = resolve; }),
    );

    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    resolveList([credential({ name: "srv ssh" })]);
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());
  });

  it("shows 'Used by: Embedded SSH' once a credential has actually authenticated a connection", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([
      credential({ name: "srv ssh", used_by: ["Embedded SSH"] }),
    ]);

    renderPage();
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());
    expect(screen.getByText(/Used by: Embedded SSH/i)).toBeInTheDocument();
  });

  it("does not show a 'Used by' line for a credential that has never been used", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([credential({ name: "srv ssh" })]);

    renderPage();
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());
    expect(screen.queryByText(/Used by:/i)).not.toBeInTheDocument();
  });

  it("shows an error state when the list fails to load", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockRejectedValue(new Error("network down"));

    renderPage();
    await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
  });

  it("filters the list by search text", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([
      credential({ id: 1, name: "srv ssh" }),
      credential({ id: 2, name: "mail relay" }),
    ]);

    renderPage();
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());
    expect(screen.getByText("mail relay")).toBeInTheDocument();

    const search = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(search, { target: { value: "mail" } });

    await waitFor(() => expect(screen.queryByText("srv ssh")).not.toBeInTheDocument());
    expect(screen.getByText("mail relay")).toBeInTheDocument();
  });

  it("hides the New credential button without vault_create permission", async () => {
    mockAuth({ can: () => false, hasPermission: (perm: string) => perm === "vault_view" });
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([credential()]);

    renderPage();
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());
    expect(screen.queryByText(/new credential/i)).not.toBeInTheDocument();
  });

  it("shows a permission-denied message with no vault_view access at all", async () => {
    mockAuth({ can: () => false, hasPermission: () => false });
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([]);

    renderPage();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
  });

  it("shows the force-delete confirmation when a delete is blocked by a 409", async () => {
    mockAuth();
    vi.spyOn(vaultApi, "listVaultCredentialTypes").mockResolvedValue(TYPES);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([]);
    vi.spyOn(vaultApi, "listVaultCredentials").mockResolvedValue([credential({ name: "srv ssh" })]);
    vi.spyOn(vaultApi, "deleteVaultCredential").mockRejectedValue(
      new ApiError('Credential "srv ssh" is still referenced by: Client #1 (Acme). Delete again with confirmation to override.', 409),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText("srv ssh")).toBeInTheDocument());

    screen.getByTitle("Delete").click();
    const confirmDialog = await screen.findByRole("dialog");
    within(confirmDialog).getByRole("button", { name: "Delete" }).click();

    await waitFor(() => expect(screen.getByText(/still in use/i)).toBeInTheDocument());
    expect(screen.getByText(/still referenced by: Client #1/i)).toBeInTheDocument();
  });
});
