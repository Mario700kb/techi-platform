import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { Device, DeviceQuickCounts } from "../../api/devices";
import DevicesTable from "../DevicesTable";

vi.mock("../../hooks/usePlatformFeatures", () => ({
  usePlatformFeatures: () => ({ FEATURE_LINUX: false }),
}));
vi.mock("../../api/connect", () => ({
  CONNECT_REFRESH_EVENT: "connect-refresh",
  getConnectStatuses: vi.fn().mockResolvedValue({}),
}));

// Filtering, sorting and counting moved to the server: the table used to
// filter and re-sort the 20 rows of the current page and count pills from
// them. It must now show rows exactly as delivered and the server's counts.

const devices = [
  { id: 1, hostname: "zulu", freshness_state: "online", platform: "windows" },
  { id: 2, hostname: "alpha", freshness_state: "offline", platform: "windows" },
  { id: 3, hostname: "mike", freshness_state: "online", platform: "windows" },
] as Device[];

const counts = {
  all: 812, online: 640, stale: 12, offline: 160, servers: 40, workstations: 700, maintenance: 3,
  critical: 15, warnings: 30, healthy: 700, needs_updates: 19, reboot_required: 7,
  needs_attention: 180, low_health: 22, rustdesk_issues: 5, needs_agent_update: 23, favorites: 0,
} as DeviceQuickCounts["counts"];

function renderTable(overrides: Partial<React.ComponentProps<typeof DevicesTable>> = {}) {
  const props: React.ComponentProps<typeof DevicesTable> = {
    devices,
    loading: false,
    error: null,
    filters: {},
    searchQuery: "",
    onSearch: vi.fn(),
    onFilterChange: vi.fn(),
    onRefresh: vi.fn(),
    quickFilter: "all",
    onQuickFilterChange: vi.fn(),
    quickCounts: counts,
    agentVersionCounts: { "2.1.20": 700, "2.0.0": 8, unknown: 4 },
    sortKey: "hostname",
    sortDir: "asc",
    onSortChange: vi.fn(),
    agentVersionFilter: "all",
    onAgentVersionFilterChange: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof DevicesTable>;
  render(
    <MemoryRouter>
      <DevicesTable {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("DevicesTable with server-side filters", () => {
  it("keeps the server's row order instead of re-sorting the page", () => {
    renderTable();
    const table = screen.getByRole("table");
    const names = within(table).getAllByText(/^(zulu|alpha|mike)$/).map((el) => el.textContent);
    expect(names).toEqual(["zulu", "alpha", "mike"]);
  });

  it("shows the server's counts on the tabs and quick filters", () => {
    renderTable();
    const tabs = screen.getByRole("tablist", { name: "Device status" });
    expect(within(tabs).getByRole("tab", { name: /Critical/ })).toHaveTextContent("15");
    expect(within(tabs).getByRole("tab", { name: /All/ })).toHaveTextContent("812");
    expect(screen.getByRole("button", { name: /Reboot required/ })).toHaveTextContent("7");
  });

  it("asks the server to sort when a column header is clicked", () => {
    const props = renderTable();
    fireEvent.click(within(screen.getByRole("table")).getByText("Client / group"));
    expect(props.onSortChange).toHaveBeenCalledWith("client_name");
  });

  it("does not hide rows that the active quick filter would not match locally", () => {
    renderTable({ quickFilter: "critical" });
    expect(within(screen.getByRole("table")).getByText("alpha")).toBeInTheDocument();
  });
});
