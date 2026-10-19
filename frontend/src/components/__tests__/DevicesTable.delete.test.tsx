import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/client";
import type { Device } from "../../api/devices";
import DevicesTable from "../DevicesTable";

vi.mock("../../hooks/usePlatformFeatures", () => ({
  usePlatformFeatures: () => ({ FEATURE_LINUX: false }),
}));
vi.mock("../../api/connect", () => ({
  CONNECT_REFRESH_EVENT: "connect-refresh",
  getConnectStatuses: vi.fn().mockResolvedValue({}),
}));

function renderTable(device: Partial<Device>, handlers: Record<string, unknown>) {
  render(
    <MemoryRouter>
      <DevicesTable
        {...({
          devices: [{ id: 7, hostname: "kleivid-pc", freshness_state: "offline", platform: "windows", ...device }],
          loading: false,
          error: null,
          filters: {},
          searchQuery: "",
          onSearch: vi.fn(),
          onFilterChange: vi.fn(),
          onRefresh: vi.fn(),
          canOperate: true,
          canDelete: true,
          ...handlers,
        } as unknown as React.ComponentProps<typeof DevicesTable>)}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "More actions for kleivid-pc" }));
}

describe("DevicesTable · delete to the trash", () => {
  it("asks for a reason and a two-factor code, then moves the device to the trash", async () => {
    const onDeviceDelete = vi.fn().mockResolvedValue(undefined);
    renderTable({}, { onDeviceDelete });
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete device/ }));

    const confirm = screen.getByRole("button", { name: "Move to trash" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/PC sold/), { target: { value: "duplicate of 978" } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "12a3456" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onDeviceDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), "duplicate of 978", "123456"));
  });

  it("shows a wrong code in the dialog and keeps it open", async () => {
    const onDeviceDelete = vi.fn().mockRejectedValue(new ApiError("bad", 403, "mfa_invalid"));
    renderTable({}, { onDeviceDelete });
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete device/ }));
    fireEvent.change(screen.getByPlaceholderText(/PC sold/), { target: { value: "sold" } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong or expired code");
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeDisabled();
  });

  it("offers Delete permanently for a device in the trash, with a code and no reason", async () => {
    const onDevicePurge = vi.fn().mockResolvedValue(undefined);
    renderTable({ is_archived: true, deleted_at: "2026-10-19T13:00:00Z" }, { onDevicePurge });
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete permanently/ }));

    expect(screen.queryByPlaceholderText(/PC sold/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(onDevicePurge).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), "654321"));
  });
});
