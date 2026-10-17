import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as devicesApi from "../../api/devices";
import * as monitoringApi from "../../api/monitoring";
import type { ClientMonitoring } from "../../api/monitoring";
import { appCache } from "../../store/appCache";
import ClientAnalytics, { AnalyticsRange } from "../ClientAnalytics";

const hours = (fn: (h: number) => number | null) => Array.from({ length: 24 }, (_, h) => fn(h));

function monitoring(overrides: Partial<ClientMonitoring> = {}): ClientMonitoring {
  return {
    range: "7d",
    devices_total: 3,
    devices_reporting: 2,
    one_minute_devices: 2,
    coverage_pct: 99.74,
    coverage_breakdown: { received: 9900, late: 80, missing_minutes: 26, off_minutes: 0, pct: 99.74, segments: [] },
    monitor_alerts: 3,
    monitor_alerts_open: 1,
    cpu_avg: 18.2,
    busiest_hour: 10,
    busiest_hour_cpu: 41,
    disks_at_risk: 1,
    heatmap: [
      { device_id: 11, name: "HV-PROD-01", cells: hours((h) => (h === 2 ? 82 : 24)), peak: 97 },
      { device_id: 12, name: "Flori-PC", cells: hours((h) => (h >= 8 && h <= 18 ? 30 : null)), peak: 88 },
    ],
    trend: Array.from({ length: 6 }, (_, i) => ({
      t: `2026-10-1${i}T10:00:00`,
      cpu_avg: 10 + i,
      cpu_p95: 40 + i,
      mem_avg: 50,
    })),
    attention: [
      {
        device_id: 11,
        name: "HV-PROD-01",
        kind: "disk_forecast",
        severity: "critical",
        title: "HV-PROD-01 · D: fills up",
        detail: "86% used: 90% in 5 days.",
      },
      {
        device_id: 13,
        name: "LAPTOP-TECHI",
        kind: "not_seen",
        severity: "info",
        title: "LAPTOP-TECHI · not seen for 15 days",
        detail: "No heartbeat or telemetry since then.",
      },
    ],
    devices: [
      {
        device_id: 11,
        name: "HV-PROD-01",
        kind: "server",
        agent_version: "2.1.29",
        spark: [10, 20, 30, null, 25],
        cpu_peak: 97,
        mem_peak: 84,
        disk_worst: "D:",
        disk_worst_pct: 86,
        coverage_pct: 99.98,
        one_minute: true,
        monitors_firing: 1,
      },
      {
        device_id: 14,
        name: "Rudi-PC",
        kind: "client",
        agent_version: "2.1.20",
        spark: [5, 9, 7],
        cpu_peak: 42,
        mem_peak: 51,
        disk_worst: null,
        disk_worst_pct: 72,
        coverage_pct: null,
        one_minute: false,
        monitors_firing: 0,
      },
    ],
    ...overrides,
  };
}

const insights: devicesApi.FleetInsights = {
  availability: {
    days: 30,
    series: [{ date: "2026-10-16", availability_pct: 98 }],
    overall_pct: 97.2,
    coverage_pct: 100,
    device_count: 3,
  },
  alerts: { days: 30, series: [], opened_total: 4, resolved_total: 2, open_now: 2, mean_time_to_resolve_hours: 3.5 },
  problem_devices: [],
  generated_at: "2026-10-17T08:00:00Z",
};

function setup(data: ClientMonitoring | Error = monitoring(), range: AnalyticsRange = "7d") {
  const getMonitoring = vi.spyOn(monitoringApi, "getClientMonitoring");
  if (data instanceof Error) getMonitoring.mockRejectedValue(data);
  else getMonitoring.mockResolvedValue(data);
  vi.spyOn(devicesApi, "getFleetInsights").mockResolvedValue(insights);
  const onOpenDevice = vi.fn();
  const onRangeChange = vi.fn();
  const view = render(
    <ClientAnalytics clientId={1} range={range} onRangeChange={onRangeChange} onOpenDevice={onOpenDevice} />,
  );
  return { ...view, getMonitoring, onOpenDevice, onRangeChange };
}

describe("ClientAnalytics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
  });

  it("shows the client's figures, heatmap, attention and devices", async () => {
    const { getMonitoring } = setup();
    expect(screen.getByLabelText("Loading analytics")).toBeInTheDocument();

    expect(await screen.findByText("2 / 3")).toBeInTheDocument();
    expect(getMonitoring).toHaveBeenCalledWith(1, "7d");
    expect(screen.getByText("1 not seen in 24 h")).toBeInTheDocument();
    expect(screen.getAllByText("99.7%").length).toBeGreaterThan(0);
    expect(screen.getByText("1 open · 2 resolved")).toBeInTheDocument();
    expect(screen.getByText("Busiest hour 10:00 · 41%")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 devices on 1-minute data · hourly averages")).toBeInTheDocument();

    // Heatmap: one row per device, busiest first, 24 hours each.
    const heat = screen.getByRole("region", { name: "CPU load by device and hour" });
    const rows = within(heat).getAllByRole("button", { name: /^Open / });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Open HV-PROD-01, peak CPU 97%",
      "Open Flori-PC, peak CPU 88%",
    ]);
    expect(rows[0].querySelectorAll(".th-ca-heat-cell")).toHaveLength(24);
    expect(rows[1].querySelectorAll('.th-ca-heat-cell[data-off="true"]')).toHaveLength(13);

    // Needs attention, as the backend words it.
    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText("HV-PROD-01 · D: fills up")).toBeInTheDocument();
    expect(within(attention).getByText("No heartbeat or telemetry since then.")).toBeInTheDocument();

    // Coverage split: on time, late from the buffer, agent stopped.
    const coverage = screen.getByRole("region", { name: "Data coverage" });
    expect(within(coverage).getByText("Received late, from the device buffer")).toBeInTheDocument();
    expect(within(coverage).getByText("Device-off time is not counted as missing.")).toBeInTheDocument();

    // Devices: an older agent shows 5-minute data only.
    const table = within(screen.getByRole("region", { name: "Devices" })).getByRole("table");
    const hv = within(table).getByRole("row", { name: "Open HV-PROD-01" });
    expect(within(hv).getByText("1 firing")).toBeInTheDocument();
    expect(within(hv).getByText("D: 86%")).toBeInTheDocument();
    const rudi = within(table).getByRole("row", { name: "Open Rudi-PC" });
    expect(within(rudi).getByText("5-min only")).toBeInTheDocument();
    expect(within(rudi).getByText("Client PC · agent 2.1.20")).toBeInTheDocument();

    // The 30-day status history stays below.
    expect(await screen.findByText("Alerts opened and resolved")).toBeInTheDocument();
    expect(screen.getByText(/3\.5 h to resolve on average/)).toBeInTheDocument();
  });

  it("opens a device from the heatmap, an attention card and a table row", async () => {
    const { onOpenDevice } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open Flori-PC, peak CPU 88%" }));
    expect(onOpenDevice).toHaveBeenLastCalledWith(12);
    fireEvent.click(screen.getByRole("button", { name: /LAPTOP-TECHI · not seen/ }));
    expect(onOpenDevice).toHaveBeenLastCalledWith(13);
    const row = screen.getByRole("row", { name: "Open Rudi-PC" });
    fireEvent.click(row);
    expect(onOpenDevice).toHaveBeenLastCalledWith(14);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenDevice).toHaveBeenCalledTimes(4);
  });

  it("switches the range and asks for that range", async () => {
    const { onRangeChange, getMonitoring, rerender, onOpenDevice } = setup();
    await screen.findByText("2 / 3");
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(onRangeChange).toHaveBeenCalledWith("30d");

    getMonitoring.mockResolvedValue(monitoring({ range: "30d", devices_reporting: 3 }));
    rerender(<ClientAnalytics clientId={1} range="30d" onRangeChange={onRangeChange} onOpenDevice={onOpenDevice} />);
    expect(screen.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
    expect(getMonitoring).toHaveBeenLastCalledWith(1, "30d");
    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText(/daily averages$/)).toBeInTheDocument();
  });

  it("works from heartbeat data before any device runs agent 2.1.29", async () => {
    setup(
      monitoring({
        one_minute_devices: 0,
        coverage_pct: null,
        coverage_breakdown: { received: 0, late: 0, missing_minutes: 0, off_minutes: 0, pct: null, segments: [] },
        devices: monitoring().devices.map((d) => ({ ...d, one_minute: false, coverage_pct: null, monitors_firing: 0 })),
      }),
    );
    expect(
      await screen.findByText(/1-minute data and coverage arrive as devices update to agent 2\.1\.29/),
    ).toBeInTheDocument();
    expect(screen.getByText("Arrives with agent 2.1.29")).toBeInTheDocument();
    expect(screen.getByText("Coverage arrives as devices update to agent 2.1.29.")).toBeInTheDocument();
    expect(screen.getAllByText("5-min only")).toHaveLength(2);
    expect(screen.getByText("5-minute heartbeat data · hourly averages")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    const { getMonitoring } = setup(new Error("Server unavailable"));
    expect(await screen.findByText("Couldn't load analytics")).toBeInTheDocument();
    expect(screen.getByText("Server unavailable")).toBeInTheDocument();

    getMonitoring.mockResolvedValue(monitoring());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2 / 3")).toBeInTheDocument();
  });
});
