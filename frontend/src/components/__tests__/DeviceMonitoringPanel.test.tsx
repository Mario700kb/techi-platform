import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeviceMonitoringPanel from "../DeviceMonitoringPanel";
import DeviceLast24hCard, { monitorsSummary } from "../DeviceLast24hCard";
import { appCache } from "../../store/appCache";
import { metricsFixture, monitoringFixture } from "./monitoringFixtures";

const getMetrics = vi.fn();
const getMonitoring = vi.fn();

vi.mock("../../api/monitoring", async (importActual) => ({
  ...(await importActual<typeof import("../../api/monitoring")>()),
  getDeviceMetrics: (...a: unknown[]) => getMetrics(...a),
  getDeviceMonitoring: (...a: unknown[]) => getMonitoring(...a),
}));

describe("DeviceMonitoringPanel", () => {
  beforeEach(() => {
    appCache.invalidate();
    getMetrics.mockReset().mockResolvedValue(metricsFixture());
    getMonitoring.mockReset().mockResolvedValue(monitoringFixture(true));
  });

  it("draws charts, disks with a forecast, coverage, monitors and delivery", async () => {
    const onShowAlerts = vi.fn();
    render(<DeviceMonitoringPanel deviceId={7} active onShowAlerts={onShowAlerts} />);

    expect(await screen.findByText("1-minute data from the agent · nothing lost")).toBeInTheDocument();
    expect(getMetrics).toHaveBeenCalledWith(7, "24h");
    expect(screen.getByRole("img", { name: "CPU usage over time" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Memory used over time" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Network receive and send over time" })).toBeInTheDocument();
    expect(screen.getByText(/p95 31% · peak 71%/)).toBeInTheDocument();
    // The CPU monitor's threshold is drawn on the chart.
    expect(screen.getByText("alert 95% · 15 min")).toBeInTheDocument();

    const disks = screen.getAllByTestId("disk-row");
    expect(disks).toHaveLength(2);
    expect(within(disks[0]).getByText("stable")).toBeInTheDocument();
    expect(within(disks[1]).getByText("grows 1.1 GB/day · 90% in 9 days · full in 41 days")).toBeInTheDocument();

    const coverage = screen.getByRole("region", { name: "Data coverage" });
    expect(within(coverage).getByText("99.98%")).toBeInTheDocument();
    expect(within(coverage).getByText("931 samples")).toBeInTheDocument();
    expect(within(coverage).getByText("Agent stopped")).toBeInTheDocument();
    expect(within(coverage).getByText("2 h")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-bar").querySelectorAll("[data-kind]")).toHaveLength(6);

    const monitors = screen.getByRole("region", { name: "Monitors" });
    expect(within(monitors).getByText("Workstations · v3")).toBeInTheDocument();
    expect(within(monitors).getByText("Firing")).toBeInTheDocument();
    expect(within(monitors).getByText("Watch")).toBeInTheDocument();
    fireEvent.click(within(monitors).getByRole("button", { name: "Alert #77" }));
    expect(onShowAlerts).toHaveBeenCalled();

    const delivery = screen.getByTestId("delivery");
    expect(within(delivery).getByText("4 samples")).toBeInTheDocument();
    expect(within(delivery).getByText("+0.4 s")).toBeInTheDocument();
    expect(within(delivery).getByText("v3")).toBeInTheDocument();
    expect(within(delivery).getByText("current")).toBeInTheDocument();
  });

  it("switches range and explains heartbeat-only data", async () => {
    getMetrics.mockImplementation((_id: number, range: string) =>
      Promise.resolve(metricsFixture({ range: range as "7d", source: range === "7d" ? "heartbeat" : "agent" })),
    );
    render(<DeviceMonitoringPanel deviceId={7} active />);
    await screen.findByText("1-minute data from the agent · nothing lost");
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
    expect(
      await screen.findByText("5-minute heartbeat data — update the agent to 2.1.29 for 1-minute data"),
    ).toBeInTheDocument();
    expect(getMetrics).toHaveBeenLastCalledWith(7, "7d");
  });

  it("shows an empty state, and a retry when metrics fail", async () => {
    getMetrics.mockResolvedValueOnce(metricsFixture({ source: "none", points: [], disks: [] }));
    const { unmount } = render(<DeviceMonitoringPanel deviceId={7} active />);
    expect(await screen.findByText("No metrics in the last 24 h")).toBeInTheDocument();
    unmount();

    appCache.invalidate();
    getMetrics.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(metricsFixture());
    render(<DeviceMonitoringPanel deviceId={8} active />);
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("1-minute data from the agent · nothing lost")).toBeInTheDocument();
  });

  it("loads nothing while the tab is hidden", () => {
    render(<DeviceMonitoringPanel deviceId={7} active={false} />);
    expect(getMetrics).not.toHaveBeenCalled();
    expect(getMonitoring).not.toHaveBeenCalled();
  });

  it("refreshes every minute on short ranges", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<DeviceMonitoringPanel deviceId={7} active />);
      await waitFor(() => expect(getMetrics).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(getMetrics).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DeviceLast24hCard", () => {
  beforeEach(() => {
    appCache.invalidate();
    getMetrics.mockReset().mockResolvedValue(metricsFixture());
    getMonitoring.mockReset().mockResolvedValue(monitoringFixture(false));
  });

  it("sums up the day and opens Monitoring", async () => {
    const open = vi.fn();
    render(<DeviceLast24hCard deviceId={7} active onOpenMonitoring={open} />);
    const card = await screen.findByRole("region", { name: "Last 24 hours" });
    expect(await within(card).findByText("12%")).toBeInTheDocument();
    expect(within(card).getByText(/peak 71% at/)).toBeInTheDocument();
    expect(within(card).getByText(/peak 48%/)).toBeInTheDocument();
    expect(within(card).getByText("of the time it was on").parentElement).toHaveTextContent("Coverage100%");
    expect(within(card).getByText("1-minute data · nothing lost")).toBeInTheDocument();
    expect(await within(card).findByTestId("monitors-summary")).toHaveTextContent("1 near the limit · Disk above 90%");
    fireEvent.click(within(card).getByRole("button", { name: /Open Monitoring/ }));
    expect(open).toHaveBeenCalled();
  });

  it("words the monitors summary", () => {
    expect(monitorsSummary(monitoringFixture(true))?.text).toBe("1 firing · CPU above 95% for 15 min");
    const allOk = monitoringFixture(false);
    allOk.monitors = allOk.monitors.map((m) => ({ ...m, state: "ok" }));
    expect(monitorsSummary(allOk)).toEqual({ state: "ok", text: "All 4 monitors OK" });
    expect(monitorsSummary({ ...allOk, monitors: [] })?.text).toBe("No monitors apply");
    expect(monitorsSummary(undefined)).toBeNull();
  });
});
