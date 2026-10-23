import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../../api/enrollmentBootstrap";
import * as clientsApi from "../../api/clients";
import * as packagesApi from "../../api/agentPackages";
import Deployment from "../Deployment";
import { appCache } from "../../store/appCache";

vi.mock("../../hooks/usePlatformFeatures", () => ({
  usePlatformFeatures: () => ({ FEATURE_LINUX: true, FEATURE_MIKROTIK: false }),
}));

const token = (over: Record<string, unknown>) => ({
  status: "active",
  created_at: "2026-09-01T08:00:00Z",
  expires_at: null,
  used_at: null,
  last_used_at: null,
  max_uses: 25,
  use_count: 1,
  client_id: null,
  group_id: null,
  is_default: false,
  token_prefix: "abcd1234",
  has_recoverable_token: false,
  usage_warning: null,
  ...over,
});

const TOKENS = [
  token({ id: 1, name: "Vanto", client_id: 42, last_used_at: new Date(Date.now() - 3600_000).toISOString() }),
  token({ id: 2, name: "Hodaj", use_count: 0 }),
  token({ id: 3, name: "Full one", status: "used", use_count: 25, usage_warning: "critical" }),
  token({ id: 4, name: "Default Deployment", is_default: true, max_uses: 500 }),
];

const pkg = (over: Record<string, unknown>) => ({
  uploaded_at: "2026-10-22T05:43:00Z",
  is_active: true,
  download_url: "/x",
  sha256: "a".repeat(64),
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Deployment />
    </MemoryRouter>,
  );
}

describe("Deployment (Tokens & commands)", () => {
  beforeEach(() => {
    appCache.invalidate();
    vi.spyOn(api, "getEnrollmentTokens").mockResolvedValue(TOKENS as never);
    vi.spyOn(api, "getRustDeskConfig").mockResolvedValue({ server_host: "h", relay_host: "h", public_key: "k" });
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([{ id: 42, name: "Vanto shpk", is_active: true }] as never);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue([] as never);
    vi.spyOn(packagesApi, "getAgentPackages").mockResolvedValue([
      pkg({ id: "u", version: "2.1.35.0", platform: "windows-amd64", file_type: "agent_update_msi", filename: "TECHI-Agent-Update-2.1.35.msi" }),
      pkg({ id: "m", version: "2.1.34.0", platform: "windows-amd64", file_type: "msi", filename: "TECHI-Agent-2.1.34.msi" }),
      pkg({ id: "l", version: "2.1.39", platform: "linux-amd64", file_type: "agent_binary", filename: "a.bin" }),
    ] as never);
  });

  it("shows client names, when a token last enrolled a device, and Never otherwise", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    const vanto = within(table).getByText("Vanto").closest("tr")!;
    expect(within(vanto).getByText("Vanto shpk")).toBeInTheDocument();
    expect(within(vanto).getByText("1h ago")).toBeInTheDocument();
    const hodaj = within(table).getByText("Hodaj").closest("tr")!;
    expect(within(hodaj).getByText("Unused")).toBeInTheDocument();
    expect(within(hodaj).getByText("Never")).toBeInTheDocument();
    expect(within(table).getByLabelText("Default deployment token")).toBeInTheDocument();
  });

  it("filters by status tab and by search", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    fireEvent.click(screen.getByRole("tab", { name: /Exhausted/ }));
    expect(within(table).getByText("Full one")).toBeInTheDocument();
    expect(within(table).queryByText("Hodaj")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tokens" }), { target: { value: "vanto shpk" } });
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });

  it("shows Expires only when a token expires", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    expect(within(table).queryByRole("columnheader", { name: "Expires" })).toBeNull();
  });

  it("keeps the rarer actions in the row menu, Diagnostics included", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "More actions for Vanto" }));
    const menu = screen.getByRole("menu", { name: "More actions for Vanto" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Edit",
      "Regenerate value",
      "Diagnostics",
      "Revoke",
      "Delete",
    ]);
  });

  it("names the Endpoint MSI as what a new install downloads, never the update bridge", async () => {
    renderPage();
    await screen.findByRole("table");
    const card = (await screen.findByText("Windows · Endpoint MSI")).closest("dl")!;
    expect(within(card).getByText("2.1.34.0")).toBeInTheDocument();
    expect(within(card).queryByText("2.1.35.0")).toBeNull();
    expect(within(card).getByText("amd64 2.1.39 · arm64 none · armhf none")).toBeInTheDocument();
  });
});
