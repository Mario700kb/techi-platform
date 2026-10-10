import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { chooseOption, findOption, openSelect } from "../../test/select";
import { afterEach, describe, expect, it, vi } from "vitest";

import Reports from "../Reports";
import * as reportsApi from "../../api/reports";
import * as devicesApi from "../../api/devices";
import * as authContext from "../../auth/AuthContext";

const run = (overrides: Partial<reportsApi.ReportRun> = {}): reportsApi.ReportRun => ({
  id: 1, schedule_id: null, client_id: 1, client_name: "Eugreen", report_format: "pdf",
  period_start: "2026-09-01T00:00:00Z", period_end: "2026-09-30T00:00:00Z",
  status: "completed", filename: "report.pdf", size_bytes: 1200, error_message: null,
  generated_by: "mario", created_at: "2026-09-30T00:00:00Z", completed_at: "2026-09-30T00:00:01Z",
  ...overrides,
});

function mockPage() {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "mario", role: "admin" } as any, token: "t", loading: false,
    permissions: null, login: vi.fn(), logout: vi.fn(), can: () => true,
    hasAnyRole: vi.fn(), hasPermission: () => true,
  });
  vi.spyOn(reportsApi, "getReportClients").mockResolvedValue([{ id: 1, name: "Eugreen" }]);
  vi.spyOn(reportsApi, "getReportRuns").mockResolvedValue({ items: [run(), run({ id: 2, scope_type: "device", device_id: 606, device_name: "Owner-04", report_type: "user_activity" })], total: 2 });
  vi.spyOn(reportsApi, "getReportSchedules").mockResolvedValue([]);
  vi.spyOn(reportsApi, "downloadReport").mockResolvedValue();
  vi.spyOn(devicesApi, "getDevices").mockResolvedValue({ devices: [{ id: 606, hostname: "Owner-04", client_name: "Eugreen" } as devicesApi.Device], total: 1 });
}

describe("Reports scope and history", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the existing client generation path and labels old history rows", async () => {
    mockPage();
    const generate = vi.spyOn(reportsApi, "generateReport").mockResolvedValue(run({ id: 3 }));
    render(<Reports />);
    await findOption("Client", "Eugreen");
    expect(screen.getByRole("combobox", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByText("User Activity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][0]).toMatchObject({ scope_type: "client", client_id: 1, report_type: "full", report_format: "pdf", period_days: 30 });
  });

  it("generates a device category for a custom range", async () => {
    mockPage();
    const generate = vi.spyOn(reportsApi, "generateReport").mockResolvedValue(run({ scope_type: "device", device_id: 606, device_name: "Owner-04", report_type: "alerts" }));
    render(<Reports />);
    await findOption("Client", "Eugreen");
    await chooseOption("Scope", "device");
    await waitFor(() => expect(devicesApi.getDevices).toHaveBeenCalled());
    await findOption("Device", "Owner-04 · Eugreen · #606");
    await chooseOption("Report type", "alerts");
    await chooseOption("Period", "custom");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To (inclusive)"), { target: { value: "2026-09-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][0]).toMatchObject({
      scope_type: "device", device_id: 606, report_type: "alerts", report_format: "pdf",
      // Whole Tirana days (CEST, UTC+2): 1 Sep 00:00 to 4 Sep 00:00 local.
      period_from: "2026-08-31T22:00:00.000Z", period_to: "2026-09-03T22:00:00.000Z",
    });
    expect(generate.mock.calls[0][0].client_id).toBeUndefined();
  });

  it("disables CSV for a Full Device Report", async () => {
    mockPage();
    render(<Reports />);
    await findOption("Client", "Eugreen");
    await chooseOption("Scope", "device");
    const formats = await openSelect("Format");
    expect(formats.querySelector('[role="option"][data-value="csv"]')).toHaveAttribute("aria-disabled", "true");
  });

  it("selects CSV for a device category and downloads a stored history run", async () => {
    mockPage();
    const generate = vi.spyOn(reportsApi, "generateReport").mockResolvedValue(run({ id: 3, scope_type: "device", device_name: "Owner-04", report_type: "alerts", report_format: "csv" }));
    render(<Reports />);
    await findOption("Client", "Eugreen");
    await chooseOption("Scope", "device");
    await findOption("Device", "Owner-04 · Eugreen · #606");
    await chooseOption("Report type", "alerts");
    await chooseOption("Format", "csv");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generate.mock.calls[0][0]).toMatchObject({ report_type: "alerts", report_format: "csv" }));
    const downloadButtons = screen.getAllByRole("button", { name: "Download" });
    fireEvent.click(downloadButtons[0]);
    await waitFor(() => expect(reportsApi.downloadReport).toHaveBeenCalled());
  });
});
