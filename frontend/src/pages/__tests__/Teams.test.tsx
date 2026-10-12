import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as teamsApi from "../../api/teams";
import Teams from "../Teams";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

const team = (id: number, name: string, extra: Partial<teamsApi.TeamWithStats> = {}) =>
  ({
    id,
    name,
    description: null,
    color: "#E85A3C",
    created_at: "2026-06-04T08:00:00Z",
    permissions: null,
    member_count: 1,
    client_count: 0,
    group_count: 0,
    explicit_device_count: 0,
    effective_device_count: 0,
    operator_ids: [],
    ...extra,
  }) as unknown as teamsApi.TeamWithStats;

describe("Teams", () => {
  afterEach(() => vi.restoreAllMocks());

  it("summarises reach, opens a team from its row and searches", async () => {
    vi.spyOn(teamsApi, "listTeams").mockResolvedValue([
      team(1, "IT Support", { member_count: 5, group_count: 29, effective_device_count: 774 }),
      team(2, "Metropol IT", { client_count: 1, effective_device_count: 115 }),
    ]);
    render(
      <MemoryRouter initialEntries={["/teams"]}>
        <Routes>
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/:id" element={<p>team page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("IT Support · devices")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search teams" }), { target: { value: "metropol" } });
    expect(screen.queryByText("IT Support", { selector: ".th-alerts-primary" })).toBeNull();

    fireEvent.click(screen.getByText("Metropol IT", { selector: ".th-alerts-primary" }));
    expect(await screen.findByText("team page")).toBeInTheDocument();
  });
});
