import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../../api/enrollmentBootstrap";
import * as clientsApi from "../../api/clients";
import { API_BASE_URL } from "../../api/client";
import EnrollmentBootstrap from "../EnrollmentBootstrap";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

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

function renderPage() {
  return render(
    <MemoryRouter>
      <EnrollmentBootstrap />
    </MemoryRouter>,
  );
}

describe("EnrollmentBootstrap", () => {
  beforeEach(() => {
    vi.spyOn(api, "getEnrollmentTokens").mockResolvedValue(TOKENS as never);
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([{ id: 42, name: "Vanto shpk", is_active: true }] as never);
  });

  it("defaults the backend URL to the API this console uses", async () => {
    renderPage();
    await screen.findByRole("table");
    expect(screen.getByDisplayValue(API_BASE_URL)).toBeInTheDocument();
  });

  it("shows client names, when a token last enrolled a device, and Never otherwise", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    const vanto = within(table).getByText("Vanto").closest("tr")!;
    expect(within(vanto).getByText("Vanto shpk")).toBeInTheDocument();
    expect(within(vanto).getByText("1h ago")).toBeInTheDocument();
    const hodaj = within(table).getByText("Hodaj").closest("tr")!;
    expect(within(hodaj).getByText("Unused")).toBeInTheDocument();
  });

  it("filters by status tab and by search", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    fireEvent.click(screen.getByRole("tab", { name: /Exhausted/ }));
    expect(within(table).getByText("Full one")).toBeInTheDocument();
    expect(within(table).queryByText("Hodaj")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tokens" }), { target: { value: "vanto shpk" } });
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(2);
  });
});
