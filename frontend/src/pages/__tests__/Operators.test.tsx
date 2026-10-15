import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as operatorsApi from "../../api/operators";
import * as teamsApi from "../../api/teams";
import { appCache } from "../../store/appCache";
import Operators from "../Operators";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 2 }, can: () => true }) }));

const op = (
  id: number,
  username: string,
  role: operatorsApi.OperatorRecord["role"],
  extra: Partial<operatorsApi.OperatorRecord> = {},
): operatorsApi.OperatorRecord => ({
  id,
  username,
  email: `${username}@techi.al`,
  display_name: null,
  role,
  is_active: true,
  is_superuser: false,
  created_at: "2026-05-19T08:00:00Z",
  last_login_at: null,
  last_active_at: null,
  ...extra,
});

function mockApi() {
  vi.spyOn(operatorsApi, "getOperators").mockResolvedValue([
    op(2, "denis", "owner", { display_name: "Denis" }),
    op(5, "laura", "operator", { display_name: "Laura" }),
  ]);
  vi.spyOn(teamsApi, "listTeams").mockResolvedValue([
    { id: 1, name: "IT Support", color: "#e85a3c", operator_ids: [5] } as unknown as teamsApi.TeamWithStats,
  ]);
}

function renderPage(url = "/operators") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Operators />
    </MemoryRouter>,
  );
}

describe("Operators", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
  });

  it("keeps every action in place but locks the ones that would lock you out", async () => {
    mockApi();
    renderPage();
    const self = (await screen.findByText("Denis")).closest("tr")!;
    // Denis is both "you" and the last active owner.
    expect(within(self).getByRole("button", { name: "Deactivate Denis" })).toBeDisabled();
    expect(within(self).getByRole("button", { name: "Delete Denis" })).toBeDisabled();
    const laura = screen.getByText("Laura").closest("tr")!;
    expect(within(laura).getByRole("button", { name: "Deactivate Laura" })).toBeEnabled();
    expect(within(laura).getByRole("button", { name: "Delete Laura" })).toBeEnabled();
  });

  it("filters by role and finds an operator by team", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Laura");
    fireEvent.click(screen.getByRole("tab", { name: /Owners & admins/ }));
    expect(screen.queryByText("Laura")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search operators" }), { target: { value: "it support" } });
    expect(screen.getByText("Laura")).toBeInTheDocument();
    expect(screen.queryByText("Denis")).toBeNull();
  });

  it("opens narrowed to the operator a global-search result names", async () => {
    mockApi();
    renderPage("/operators?q=laura%40techi.al");
    expect(await screen.findByText("Laura")).toBeInTheDocument();
    expect(screen.queryByText("Denis")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search operators" })).toHaveValue("laura@techi.al");
  });
});
