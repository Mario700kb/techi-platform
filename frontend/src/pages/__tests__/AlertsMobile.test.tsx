import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as alertsApi from "../../api/alerts";
import AlertsMobile from "../AlertsMobile";

const reloadAlerts = vi.fn();
const ALERTS = [
  { id: 1, device_id: 7, device_name: "NAV-SRV", client_name: "Vasgroup", kind: "low_disk", severity: "critical", message: "Disk C: above 90%", created_at: "2026-10-12T08:00:00Z" },
  { id: 2, device_id: 7, device_name: "NAV-SRV", client_name: "Vasgroup", kind: "high_ram", severity: "warning", message: "RAM above 85%", created_at: "2026-10-12T07:00:00Z" },
  { id: 3, device_id: 9, device_name: "RHG-RECEPTION", client_name: "Rhg", kind: "device_offline", severity: "warning", message: "Offline for 26 hours", created_at: "2026-10-11T06:00:00Z" },
];

vi.mock("../../contexts/AppDataContext", () => ({ useAppData: () => ({ alerts: ALERTS, reloadAlerts }) }));

describe("AlertsMobile", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("counts by severity, filters, and hides a dismissed alert until the undo window ends", () => {
    vi.useFakeTimers();
    const resolve = vi.spyOn(alertsApi, "resolveAlert").mockResolvedValue(undefined as never);
    render(<MemoryRouter><AlertsMobile /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "1 critical" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 warning" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 devices" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Critical/ }));
    expect(screen.queryByText("Offline for 26 hours")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.queryByText("Disk C: above 90%")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Disk C: above 90%")).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss all (2)" }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(reloadAlerts).toHaveBeenCalled();
  });
});
