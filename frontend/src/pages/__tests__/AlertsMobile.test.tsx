import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as alertsApi from "../../api/alerts";
import AlertsMobile from "../AlertsMobile";

const reloadAlerts = vi.fn();
const ALERTS = [
  {
    id: 1,
    device_id: 7,
    device_name: "NAV-SRV",
    client_name: "Vasgroup",
    kind: "low_disk",
    severity: "critical",
    message: "Disk C: above 90%",
    created_at: "2026-10-12T08:00:00Z",
  },
  {
    id: 2,
    device_id: 7,
    device_name: "NAV-SRV",
    client_name: "Vasgroup",
    kind: "high_ram",
    severity: "warning",
    message: "RAM above 85%",
    created_at: "2026-10-12T07:00:00Z",
  },
  {
    id: 3,
    device_id: 9,
    device_name: "RHG-RECEPTION",
    client_name: "Rhg",
    kind: "device_offline",
    severity: "warning",
    message: "Offline for 26 hours",
    created_at: "2026-10-11T06:00:00Z",
  },
];

vi.mock("../../contexts/AppDataContext", () => ({ useAppData: () => ({ alerts: ALERTS, reloadAlerts }) }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, username: "denis" }, can: () => true, hasPermission: () => true }),
}));

describe("AlertsMobile", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts by severity, filters, and resolves only with a reason", async () => {
    const resolve = vi.spyOn(alertsApi, "resolveAlert").mockResolvedValue(undefined as never);
    render(
      <MemoryRouter>
        <AlertsMobile />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "1 critical" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 warning" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 devices" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Critical/ }));
    expect(screen.queryByText("Offline for 26 hours")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0]);
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Resolve" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Disk C: above 90%")).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resolve all (2)" }));
    fireEvent.click(screen.getByLabelText(/False alarm/));
    fireEvent.change(screen.getByPlaceholderText("Why nothing was wrong"), { target: { value: "backup window" } });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Resolve" }));
    });

    expect(resolve).toHaveBeenCalledWith(1, "false_positive", "backup window");
    expect(resolve).toHaveBeenCalledWith(2, "false_positive", "backup window");
    expect(screen.queryByText("Disk C: above 90%")).not.toBeInTheDocument();
    expect(reloadAlerts).toHaveBeenCalled();
  });
});
