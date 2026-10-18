import { AUTH_DEFAULTS } from "../../test/auth";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chooseOption, findOption, openSelect } from "../../test/select";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Reports from "../Reports";
import * as reportsApi from "../../api/reports";
import * as devicesApi from "../../api/devices";
import * as authContext from "../../auth/AuthContext";
import { appCache } from "../../store/appCache";

const run = (overrides: Partial<reportsApi.ReportRun> = {}): reportsApi.ReportRun => ({
  id: 1,
  schedule_id: null,
  client_id: 1,
  client_name: "Eugreen",
  report_format: "pdf",
  period_start: "2026-09-01T00:00:00Z",
  period_end: "2026-09-30T00:00:00Z",
  status: "completed",
  filename: "report.pdf",
  size_bytes: 1200,
  error_message: null,
  generated_by: "mario",
  created_at: "2026-09-30T00:00:00Z",
  completed_at: "2026-09-30T00:00:01Z",
  ...overrides,
});

const CATALOG: reportsApi.ReportCatalogEntry[] = [
  {
    key: "full",
    title: "Full fleet report",
    description: "The original client report",
    formats: ["pdf", "csv"],
    needs: null,
    preview: false,
  },
  {
    key: "executive",
    title: "Executive summary",
    description: "One page for management",
    formats: ["pdf"],
    needs: null,
  },
  {
    key: "lifecycle",
    title: "OS lifecycle & hardware",
    description: "Age and warranty",
    formats: ["pdf", "csv"],
    needs: null,
  },
  {
    key: "security_posture",
    title: "Security posture",
    description: "Defender and firewall",
    formats: ["pdf", "csv"],
    needs: "agent 2.1.31",
  },
];

const doc = (key: reportsApi.ClientReportKey, title: string): reportsApi.ReportDocument => ({
  key,
  title,
  subtitle: null,
  client_id: 1,
  client_name: "Eugreen",
  period_start: "2026-09-16T22:00:00Z",
  period_end: "2026-10-16T22:00:00Z",
  generated_at: "2026-10-17T08:00:00Z",
  summary: [{ label: "Devices", value: 12, hint: null, tone: "info" }],
  sections: [
    {
      key: "devices",
      title: "Devices",
      columns: [{ key: "name", label: "Device", align: "left", kind: "text" }],
      rows: [{ name: "EU-PC-01", _device_id: 606 }],
      empty: "None",
    },
  ],
  notes: [],
});

const schedule = (overrides: Partial<reportsApi.ReportSchedule> = {}): reportsApi.ReportSchedule => ({
  id: 7,
  name: "Eugreen monthly",
  client_id: 1,
  client_name: "Eugreen",
  report_type: "lifecycle",
  report_format: "pdf",
  cadence: "monthly",
  period_days: 30,
  hour_local: 8,
  day_of_week: null,
  day_of_month: 1,
  enabled: true,
  next_run_at: "2026-11-01T07:00:00Z",
  last_run_at: null,
  created_by: "mario",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

function mockPage({ schedules = [] as reportsApi.ReportSchedule[] } = {}) {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "mario", role: "admin" } as any,
    ...AUTH_DEFAULTS,
    loading: false,
    permissions: null,
    login: vi.fn(),
    logout: vi.fn(),
    can: () => true,
    hasAnyRole: vi.fn(),
    hasPermission: () => true,
  });
  vi.spyOn(reportsApi, "getReportClients").mockResolvedValue([
    { id: 1, name: "Eugreen" },
    { id: 2, name: "Northwind" },
  ]);
  vi.spyOn(reportsApi, "getReportRuns").mockResolvedValue({
    items: [
      run(),
      run({ id: 2, scope_type: "device", device_id: 606, device_name: "Owner-04", report_type: "user_activity" }),
      run({ id: 4, report_type: "executive" }),
    ],
    total: 3,
  });
  vi.spyOn(reportsApi, "getReportSchedules").mockResolvedValue(schedules);
  vi.spyOn(reportsApi, "getReportCatalog").mockResolvedValue(CATALOG);
  const preview = vi
    .spyOn(reportsApi, "getReportPreview")
    .mockImplementation(async (_client, type) => doc(type, CATALOG.find((e) => e.key === type)?.title ?? String(type)));
  vi.spyOn(reportsApi, "downloadReport").mockResolvedValue();
  vi.spyOn(devicesApi, "getDevices").mockResolvedValue({
    devices: [{ id: 606, hostname: "Owner-04", client_name: "Eugreen" } as devicesApi.Device],
    total: 1,
  });
  return { preview };
}

function renderPage(path = "/reports") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Reports />
    </MemoryRouter>,
  );
}

/** Picks a day through the app's calendar: month/year view, then the day. */
function pickDate(field: RegExp, year: number, month: RegExp, day: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: field }));
  fireEvent.click(screen.getByRole("button", { name: "Choose month and year" }));
  const shownYear = () => Number(screen.getByRole("button", { name: "Back to days" }).textContent);
  while (shownYear() > year) fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
  while (shownYear() < year) fireEvent.click(screen.getByRole("button", { name: "Next year" }));
  fireEvent.click(screen.getByRole("button", { name: month }));
  fireEvent.click(screen.getByRole("button", { name: day }));
}

const card = (title: string) =>
  within(screen.getByRole("group", { name: "Report catalog" })).getByRole("button", { name: new RegExp(title) });

beforeEach(() => appCache.invalidate());
afterEach(() => vi.restoreAllMocks());

describe("Client reports: catalog and preview", () => {
  it("shows the catalog with the executive summary first and previews it for the first client", async () => {
    const { preview } = mockPage();
    renderPage();
    const grid = await screen.findByRole("group", { name: "Report catalog" });
    const cards = within(grid).getAllByRole("button");
    expect(cards.map((c) => c.getAttribute("data-report"))).toEqual([
      "executive",
      "full",
      "lifecycle",
      "security_posture",
    ]);
    expect(cards[0]).toHaveAttribute("aria-pressed", "true");
    expect(cards[3]).toHaveTextContent("Needs agent 2.1.31");

    expect(await screen.findByRole("heading", { name: "Executive summary" })).toBeInTheDocument();
    expect(preview).toHaveBeenLastCalledWith(1, "executive", { period_days: 30 });
    // CSV is not offered by the executive summary.
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  });

  it("previews the chosen report, client and period, including a custom range", async () => {
    const { preview } = mockPage();
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });

    fireEvent.click(card("OS lifecycle & hardware"));
    expect(await screen.findByRole("heading", { name: "OS lifecycle & hardware" })).toBeInTheDocument();
    expect(preview).toHaveBeenLastCalledWith(1, "lifecycle", { period_days: 30 });

    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(1, "lifecycle", { period_days: 90 }));

    await chooseOption("Client", "2");
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(2, "lifecycle", { period_days: 90 }));

    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(await screen.findByText("Choose the dates")).toBeInTheDocument();
    pickDate(/^From/, 2026, /^Sep/, /, 1 September 2026$/);
    pickDate(/^To \(inclusive\)/, 2026, /^Sep/, /, 3 September 2026$/);
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(2, "lifecycle", {
        period_from: "2026-08-31T22:00:00.000Z",
        period_to: "2026-09-03T22:00:00.000Z",
      }),
    );
  });

  it("shows the needs note for a report that depends on a newer agent", async () => {
    mockPage();
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });
    fireEvent.click(card("Security posture"));
    expect(
      await screen.findByText("Needs agent 2.1.31. Devices that do not have it yet show no data in this report."),
    ).toBeInTheDocument();
  });

  it("shows a retry when the preview fails", async () => {
    const { preview } = mockPage();
    preview.mockRejectedValueOnce(new Error("Server error"));
    renderPage();
    expect(await screen.findByTestId("preview-error")).toHaveTextContent("Server error");
    fireEvent.click(within(screen.getByTestId("preview-error")).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Executive summary" })).toBeInTheDocument();
  });

  it("downloads a PDF: generates the client report, then downloads that run", async () => {
    mockPage();
    const created = run({ id: 9, report_type: "lifecycle", filename: "lifecycle.pdf" });
    const generate = vi.spyOn(reportsApi, "generateReport").mockResolvedValue(created);
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });
    fireEvent.click(card("OS lifecycle & hardware"));
    await screen.findByRole("heading", { name: "OS lifecycle & hardware" });
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(reportsApi.downloadReport).toHaveBeenCalledWith(created));
    expect(generate).toHaveBeenCalledWith({
      scope_type: "client",
      client_id: 1,
      report_type: "lifecycle",
      report_format: "pdf",
      period_days: 7,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("OS lifecycle & hardware PDF for Eugreen is ready.");

    // CSV is offered by this report and goes the same way.
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][0]).toMatchObject({ report_type: "lifecycle", report_format: "csv" });

    // The new run is in the runs list.
    fireEvent.click(screen.getByRole("tab", { name: /Runs/ }));
    expect(within(screen.getByRole("tab", { name: /Runs/ })).getByText("5")).toBeInTheDocument();
  });

  it("reports a failed run instead of downloading it", async () => {
    mockPage();
    vi.spyOn(reportsApi, "generateReport").mockResolvedValue(
      run({ id: 9, status: "failed", error_message: "No devices for this client" }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No devices for this client");
    expect(reportsApi.downloadReport).not.toHaveBeenCalled();
  });

  it("keeps the full client report in the catalog, as a file without a preview", async () => {
    mockPage();
    const generate = vi.spyOn(reportsApi, "generateReport").mockResolvedValue(run({ id: 3 }));
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });
    const calls = vi.mocked(reportsApi.getReportPreview).mock.calls.length;
    fireEvent.click(card("Full fleet report"));
    // No preview for "full" (the server answers 422): the panel says so and the downloads stay.
    expect(await screen.findByText("Full fleet report has no on-screen preview")).toBeInTheDocument();
    expect(card("Full fleet report")).toHaveTextContent("File only");
    expect(reportsApi.getReportPreview).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("button", { name: "Print preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][0]).toMatchObject({
      scope_type: "client",
      client_id: 1,
      report_type: "full",
      report_format: "pdf",
      period_days: 30,
    });
  });

  it("shows a retry when the catalog cannot load", async () => {
    mockPage();
    vi.mocked(reportsApi.getReportCatalog).mockRejectedValueOnce(new Error("Not found"));
    renderPage();
    expect(await screen.findByTestId("catalog-error")).toHaveTextContent("Not found");
    fireEvent.click(within(screen.getByTestId("catalog-error")).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Report catalog" })).toBeInTheDocument();
  });
});

describe("Schedules with a report type", () => {
  it("Schedule… opens the form with the report preselected and creates it with that type", async () => {
    mockPage();
    const create = vi
      .spyOn(reportsApi, "createReportSchedule")
      .mockImplementation(async (payload) => schedule({ ...payload, id: 11, client_name: "Northwind" }));
    renderPage();
    await screen.findByRole("heading", { name: "Executive summary" });
    fireEvent.click(card("OS lifecycle & hardware"));
    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    await chooseOption("Client", "2");
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));

    const dialog = await screen.findByRole("dialog", { name: "New report schedule" });
    expect(within(dialog).getByRole("combobox", { name: "Report" })).toHaveTextContent("OS lifecycle & hardware");
    expect(within(dialog).getByRole("combobox", { name: "Client" })).toHaveTextContent("Northwind");
    expect(within(dialog).getByRole("combobox", { name: "Period" })).toHaveTextContent("Last 90 days");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Schedule name" }), {
      target: { value: "Northwind lifecycle" },
    });
    await chooseOption("Cadence", "weekly");
    await chooseOption("Weekday", "4");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toEqual({
      name: "Northwind lifecycle",
      client_id: 2,
      report_type: "lifecycle",
      report_format: "pdf",
      cadence: "weekly",
      period_days: 90,
      hour_local: 8,
      day_of_week: 4,
      day_of_month: null,
    });
    // The new schedule is listed with its report type.
    const table = await screen.findByRole("table", { name: "Report schedules" });
    const row = within(table).getByRole("row", { name: /Northwind lifecycle/ });
    expect(row).toHaveTextContent("OS lifecycle & hardware");
    expect(row).toHaveTextContent("Weekly · Fri 08:00");
  });

  it("lists each schedule's report type (old ones as the full report) and edits it", async () => {
    mockPage({ schedules: [schedule(), schedule({ id: 8, name: "Legacy", report_type: undefined })] });
    const update = vi
      .spyOn(reportsApi, "updateReportSchedule")
      .mockImplementation(async (id, payload) => schedule({ id, ...payload }));
    renderPage("/reports?tab=schedules");
    const table = await screen.findByRole("table", { name: "Report schedules" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByTestId("schedule-report")
          .map((el) => el.textContent),
      ).toEqual(["OS lifecycle & hardware", "Full fleet report"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Eugreen monthly" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit schedule" });
    expect(within(dialog).getByRole("combobox", { name: "Report" })).toHaveTextContent("OS lifecycle & hardware");
    // A schedule keeps its client (the update API takes none).
    expect(within(dialog).getByRole("combobox", { name: "Client" })).toBeDisabled();
    await chooseOption("Report", "executive");
    // The executive summary is PDF only.
    const formats = await openSelect("Format");
    expect(formats.querySelector('[role="option"][data-value="csv"]')).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(formats.querySelector('[role="option"][data-value="pdf"]')!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toBe(7);
    expect(update.mock.calls[0][1]).toMatchObject({ report_type: "executive", report_format: "pdf", day_of_month: 1 });
    expect(update.mock.calls[0][1]).not.toHaveProperty("client_id");
    await waitFor(() =>
      expect(within(table).getAllByTestId("schedule-report")[0]).toHaveTextContent("Executive summary"),
    );
  });
});

describe("Device reports and runs", () => {
  it("generates a device category for a custom range", async () => {
    mockPage();
    const generate = vi
      .spyOn(reportsApi, "generateReport")
      .mockResolvedValue(run({ scope_type: "device", device_id: 606, device_name: "Owner-04", report_type: "alerts" }));
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Device reports/ }));
    await waitFor(() => expect(devicesApi.getDevices).toHaveBeenCalled());
    await findOption("Device", "Owner-04 · Eugreen · #606");
    await chooseOption("Report type", "alerts");
    await chooseOption("Period", "custom");
    pickDate(/^From/, 2026, /^Sep/, /, 1 September 2026$/);
    pickDate(/^To \(inclusive\)/, 2026, /^Sep/, /, 3 September 2026$/);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][0]).toMatchObject({
      scope_type: "device",
      device_id: 606,
      report_type: "alerts",
      report_format: "pdf",
      // Whole Tirana days (CEST, UTC+2): 1 Sep 00:00 to 4 Sep 00:00 local.
      period_from: "2026-08-31T22:00:00.000Z",
      period_to: "2026-09-03T22:00:00.000Z",
    });
    expect(generate.mock.calls[0][0].client_id).toBeUndefined();
  });

  it("disables CSV for a Full Device Report", async () => {
    mockPage();
    renderPage("/reports?tab=device");
    await findOption("Device", "Owner-04 · Eugreen · #606");
    const formats = await openSelect("Format");
    expect(formats.querySelector('[role="option"][data-value="csv"]')).toHaveAttribute("aria-disabled", "true");
  });

  it("selects CSV for a device category and downloads a stored run", async () => {
    mockPage();
    const generate = vi
      .spyOn(reportsApi, "generateReport")
      .mockResolvedValue(
        run({ id: 3, scope_type: "device", device_name: "Owner-04", report_type: "alerts", report_format: "csv" }),
      );
    renderPage("/reports?tab=device");
    await findOption("Device", "Owner-04 · Eugreen · #606");
    await chooseOption("Report type", "alerts");
    await chooseOption("Format", "csv");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(generate.mock.calls[0][0]).toMatchObject({ report_type: "alerts", report_format: "csv" }),
    );

    fireEvent.click(screen.getByRole("tab", { name: /Runs/ }));
    expect(screen.getByText("User Activity")).toBeInTheDocument();
    // Client runs carry the catalog's title.
    await waitFor(() => expect(screen.getByText("Executive summary")).toBeInTheDocument());
    const downloadButtons = screen.getAllByRole("button", { name: "Download" });
    fireEvent.click(downloadButtons[0]);
    await waitFor(() => expect(reportsApi.downloadReport).toHaveBeenCalled());
  });
});
