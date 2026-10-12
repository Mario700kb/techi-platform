import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as alertsApi from "../../api/alerts";
import type { Alert } from "../../types/alert";
import AlertsDesktop from "../AlertsDesktop";

const reloadAlerts = vi.fn();
vi.mock("../../contexts/AppDataContext", () => ({
  useAppData: () => ({ latestEvent: null, reloadAlerts }),
}));

const offline: Alert = {
  id: 11,
  device_id: 774,
  kind: "device_offline",
  severity: "critical",
  state: "open",
  message: "DESKTOP-UKPKR96 went offline",
  created_at: "2026-10-11T10:00:00Z",
  updated_at: "2026-10-11T10:00:00Z",
  device_name: "K.Xhaferri-PC",
  client_name: "TECHI shpk",
};
const cpu: Alert = {
  id: 12,
  device_id: 81,
  kind: "high_cpu",
  severity: "warning",
  state: "open",
  message: "CPU elevated on ARCH-02: 82.0%",
  created_at: "2026-10-11T09:00:00Z",
  updated_at: "2026-10-11T09:00:00Z",
  device_name: "ARCH-02",
  client_name: "Deval-ARCH",
};

function renderPage() {
  render(
    <MemoryRouter>
      <AlertsDesktop />
    </MemoryRouter>,
  );
}

describe("AlertsDesktop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    reloadAlerts.mockReset();
    vi.spyOn(alertsApi, "getAlertCount").mockResolvedValue({
      total_open: 1240,
      by_severity: { critical: 900, warning: 340 },
      by_kind: { device_offline: 900, high_cpu: 340 },
    });
  });

  it("names the device by its current name, with its client, not the hostname frozen in the message", async () => {
    vi.spyOn(alertsApi, "getAlerts").mockResolvedValue([offline, cpu]);
    renderPage();

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "K.Xhaferri-PC" })).toBeInTheDocument();
    expect(within(table).getByText("TECHI shpk")).toBeInTheDocument();
    expect(within(table).getByText("Device offline")).toBeInTheDocument();
    expect(within(table).queryByText(/DESKTOP-UKPKR96/)).not.toBeInTheDocument();
    expect(within(table).getByText("82.0%")).toBeInTheDocument();
    expect(within(table).getByText("CPU usage elevated")).toBeInTheDocument();
  });

  it("shows the server's totals on the severity tabs and asks the server to filter", async () => {
    const getAlerts = vi.spyOn(alertsApi, "getAlerts").mockResolvedValue([offline, cpu]);
    renderPage();

    const tabs = await screen.findByRole("tablist", { name: "Alert severity" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /All/ })).toHaveTextContent("1,240"));
    fireEvent.click(within(tabs).getByRole("tab", { name: /Critical/ }));

    await waitFor(() =>
      expect(getAlerts).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "open", severity: "critical", offset: 0 }),
      ),
    );
  });

  it("dismisses an alert through the API and drops it from the table", async () => {
    vi.spyOn(alertsApi, "getAlerts").mockResolvedValueOnce([offline, cpu]).mockResolvedValue([cpu]);
    const resolve = vi.spyOn(alertsApi, "resolveAlert").mockResolvedValue({ ...offline, state: "resolved" });
    renderPage();

    const table = await screen.findByRole("table");
    const row = within(table).getByRole("link", { name: "K.Xhaferri-PC" }).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(11));
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("K.Xhaferri-PC")).not.toBeInTheDocument());
    expect(reloadAlerts).toHaveBeenCalled();
  });

  it("pages through on the server with the shared table footer", async () => {
    const getAlerts = vi.spyOn(alertsApi, "getAlerts").mockResolvedValue([offline, cpu]);
    renderPage();

    expect(await screen.findByText("Showing 1–20 of 1,240 alerts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(getAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 20 })));
    expect(await screen.findByText("Showing 21–40 of 1,240 alerts")).toBeInTheDocument();
  });
});
